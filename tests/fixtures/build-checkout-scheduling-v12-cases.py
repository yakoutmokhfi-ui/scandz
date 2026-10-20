#!/usr/bin/env python3
"""Génère tests/fixtures/checkout-scheduling-v12-cases.json.

CHECKOUT SCHEDULING v1.2 (CSDJ v1.2) — ORACLE INDÉPENDANT.

Même principe que build-checkout-scheduling-cases.py (CSDJ-1) : les
ATTENDUS viennent d'une implémentation écrite dans un autre langage que
les deux livrées (`public.resolve_fulfillment_schedule_v12` en SQL,
`lib/scheduling/eligibility-v12.ts` en TypeScript), qui ne partage
aucune ligne avec elles et lit la base de fuseaux par `zoneinfo`.

Deux garde-fous supplémentaires propres à v1.2 :

  1. Les cas-frontières portent une réponse DÉRIVÉE À LA MAIN
     (`hand`), écrite AVANT d'exécuter l'oracle. Le générateur échoue si
     l'oracle la contredit : un oracle faux ne peut pas valider un SQL
     faux en silence.
  2. Aucun jeu de jours fériés réel n'est utilisé : les calendriers de
     test sont SYNTHÉTIQUES (dates arbitraires), car v1.2 ne livre ni ne
     suppose aucune juridiction.

Règles implémentées (CIO, CSDJ v1.2) :

  - Deux calendriers indépendants : PRÉPARATION (jours de la semaine +
    fermetures exceptionnelles + fériés si la politique est « closed »)
    et DISPONIBILITÉ client (fenêtres/créneaux + fermetures
    exceptionnelles + fériés si la politique est « closed »).
  - Origine : aujourd'hui si c'est un jour de préparation ET que l'heure
    limite n'est pas atteinte ; sinon le prochain jour de préparation
    STRICTEMENT postérieur. Heure limite atteinte = maintenant >= limite.
    Un jour sans préparation ne consulte pas l'heure limite.
  - J+X : cible = origine + X jours CALENDAIRES. Si la cible n'est pas
    disponible, on avance jusqu'à la prochaine date éligible.
  - Capacité (si activée) : une offre pleine est retirée ; jamais de
    compte exposé.

    python3 -I tests/fixtures/build-checkout-scheduling-v12-cases.py
"""
import datetime as dt
import json
import platform
import re
import sys
import zoneinfo
from pathlib import Path

NIL = None


def dow(d):
    """0 = dimanche, comme extract(dow) et Date#getUTCDay."""
    return (d.weekday() + 1) % 7


def parse_time(s):
    if s is None:
        return None
    m = re.fullmatch(r"(\d{2}):(\d{2})", s)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return h * 60 + mi


def fmt(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def resolve_wall(d, minutes, tz):
    """('valid_unique'|'nonexistent'|'ambiguous', instant|None) par PEP 495 (fold)."""
    z = zoneinfo.ZoneInfo(tz)
    naive = dt.datetime(d.year, d.month, d.day, minutes // 60, minutes % 60)
    instants = []
    for fold in (0, 1):
        instant = naive.replace(tzinfo=z, fold=fold).astimezone(dt.timezone.utc)
        if instant.astimezone(z).replace(tzinfo=None) == naive and instant not in instants:
            instants.append(instant)
    if not instants:
        return "nonexistent", None
    if len(instants) == 1:
        return "valid_unique", instants[0]
    return "ambiguous", None


def unfulfillable(reason):
    return {"status": "unfulfillable", "reason": reason, "firstEligibleDate": NIL, "dates": []}


def resolve(case):
    cfg = case["config"]
    if cfg is None or cfg.get("enabled") is not True:
        return {"status": "absent", "reason": NIL, "firstEligibleDate": NIL, "dates": []}
    date_mode, slot_mode = cfg["dateSelectionMode"], cfg["slotSelectionMode"]
    if date_mode == "informational_only":
        return {"status": "informational_only", "reason": NIL, "firstEligibleDate": NIL, "dates": []}
    gran = cfg.get("timeGranularityMinutes")
    if slot_mode == "time_within_window" and gran is None:
        return unfulfillable("granularity_missing")

    uses_slots = slot_mode == "fixed_slots"
    offers = {}
    rows = case["slots"] if uses_slots else case["windows"]
    for r in rows:
        offers.setdefault(r["weekday"], []).append(
            {"slotKey": r.get("slotKey") if uses_slots else NIL,
             "startsAt": r["startsAt"], "endsAt": r["endsAt"]})
    for lst in offers.values():
        lst.sort(key=lambda o: (o["startsAt"], o["slotKey"] or ""))
    if not rows:
        return unfulfillable("no_offer_configured")
    if not case["prepWeekdays"]:
        return unfulfillable("preparation_calendar_missing")

    tz = cfg["timezone"]
    z = zoneinfo.ZoneInfo(tz)
    now = dt.datetime.fromisoformat(case["nowIso"])
    today = now.astimezone(z).date()
    last = today + dt.timedelta(days=cfg["bookingHorizonDays"])

    holidays = set(case.get("holidayDays") or [])
    prep_closed = {c["closedOn"] for c in case["prepClosures"]}
    avail_closed = {c["closedOn"] for c in case["closures"]}

    def is_holiday(d):
        return d.isoformat() in holidays

    def prep_open(d):
        if dow(d) not in case["prepWeekdays"]:
            return False
        if d.isoformat() in prep_closed:
            return False
        if cfg["preparationOnHolidays"] == "closed" and is_holiday(d):
            return False
        return True

    def avail_closed_on(d):
        if d.isoformat() in avail_closed:
            return True
        return cfg["availabilityOnHolidays"] == "closed" and is_holiday(d)

    # 1. ORIGINE
    reached = False
    if prep_open(today) and cfg.get("cutoffTime") is not None:
        status, inst = resolve_wall(today, parse_time(cfg["cutoffTime"]), tz)
        if status != "valid_unique":
            return unfulfillable("cutoff_unresolvable")
        reached = now >= inst
    if prep_open(today) and not reached:
        origin = today
    else:
        origin = None
        d = today + dt.timedelta(days=1)
        while d <= last:
            if prep_open(d):
                origin = d
                break
            d += dt.timedelta(days=1)
        if origin is None:
            return unfulfillable("no_preparation_day_in_horizon")

    # 2. J+X en jours calendaires
    target = origin + dt.timedelta(days=cfg["minLeadDays"])
    if target > last:
        return unfulfillable("horizon_exhausted")

    # 3. instant minimal
    fstat, finst = resolve_wall(target, 0, tz)
    from_lead = now + dt.timedelta(minutes=cfg["leadTimeMinutes"])
    min_instant = finst if (finst is not None and finst > from_lead) else from_lead

    occupied = {(o["date"], o.get("slotKey") or ""): o["count"] for o in case.get("occupied", [])}
    cap_on = bool(cfg.get("capacityEnabled"))
    cap_max = cfg.get("capacityMaxOrders")

    eligible, saw_closed, saw_open, saw_full = [], False, False, False
    d = target
    while d <= last:
        day_offers = offers.get(dow(d))
        if not day_offers:
            d += dt.timedelta(days=1)
            continue
        if avail_closed_on(d):
            saw_closed = True
            d += dt.timedelta(days=1)
            continue
        saw_open = True
        usable = []
        for o in day_offers:
            smin, emin = parse_time(o["startsAt"]), parse_time(o["endsAt"])
            if resolve_wall(d, emin, tz)[0] != "valid_unique":
                continue
            if slot_mode == "time_within_window":
                sound, chosen, t = True, None, smin
                while t < emin:
                    st, inst = resolve_wall(d, t, tz)
                    if st != "valid_unique":
                        sound = False
                        break
                    if chosen is None and inst >= min_instant:
                        chosen = t
                    t += gran
                if not sound or chosen is None:
                    continue
                usable.append({"slotKey": NIL, "startsAt": fmt(chosen), "endsAt": fmt(emin)})
                continue
            st, inst = resolve_wall(d, smin, tz)
            if st != "valid_unique" or inst < min_instant:
                continue
            usable.append({"slotKey": o["slotKey"], "startsAt": fmt(smin), "endsAt": fmt(emin)})
        if not usable:
            d += dt.timedelta(days=1)
            continue

        # 4. capacité
        if cap_on:
            if uses_slots:
                usable = [u for u in usable
                          if occupied.get((d.isoformat(), u["slotKey"]), 0) < cap_max]
            elif occupied.get((d.isoformat(), ""), 0) >= cap_max:
                usable = []
            if not usable:
                saw_full = True
                d += dt.timedelta(days=1)
                continue

        eligible.append({"date": d.isoformat(), "offers": usable})
        if date_mode == "derived_earliest":
            break
        d += dt.timedelta(days=1)

    if not eligible:
        reason = ("capacity_exhausted" if saw_full
                  else "no_offer_in_horizon" if saw_open
                  else "all_dates_closed" if saw_closed
                  else "horizon_exhausted")
        return unfulfillable(reason)
    return {"status": "dates_available", "reason": NIL,
            "firstEligibleDate": eligible[0]["date"], "dates": eligible}


# ── Jeux d'offres (calendrier de DISPONIBILITÉ client) ──────────────────
# Mardi à samedi : ni dimanche ni lundi. C'est précisément ce qui rend les
# deux calendriers distincts : le commerçant PRÉPARE le lundi, le client
# ne peut pas RETIRER le lundi.
AVAIL_WINDOWS = (
    [{"weekday": d, "startsAt": "11:00", "endsAt": "14:00"} for d in (2, 3, 4, 5)]
    + [{"weekday": d, "startsAt": "16:00", "endsAt": "20:00"} for d in (2, 3, 4, 5)]
    + [{"weekday": 6, "startsAt": "11:00", "endsAt": "19:30"}]
)
AVAIL_SLOTS = [
    {"weekday": d, "slotKey": k, "startsAt": s, "endsAt": e}
    for d in (2, 3, 4, 5, 6)
    for k, s, e in (("11-14", "11:00", "14:00"), ("14-17", "14:00", "17:00"), ("17-20", "17:00", "20:00"))
]
PREP_MON_SAT = [1, 2, 3, 4, 5, 6]


def cfg(**kw):
    base = {
        "timezone": "Europe/Paris", "enabled": True,
        "dateSelectionMode": "customer_selectable", "slotSelectionMode": "none",
        "timeGranularityMinutes": None, "leadTimeMinutes": 0, "minLeadDays": 1,
        "cutoffTime": "10:00", "bookingHorizonDays": 14,
        "holidayCalendar": False,
        "preparationOnHolidays": "open", "availabilityOnHolidays": "open",
        "capacityEnabled": False, "capacityMaxOrders": None,
    }
    base.update(kw)
    return base


CASES = []


def add(cid, note, now, config="default", windows=None, slots=None, prep=None,
        prep_closures=(), closures=(), holidays=(), occupied=(), hand=None, **cfgkw):
    c = {
        "id": cid, "note": note,
        "config": None if config is None else cfg(**cfgkw),
        "nowIso": now,
        "prepWeekdays": list(PREP_MON_SAT if prep is None else prep),
        "prepClosures": [{"closedOn": x} for x in prep_closures],
        "windows": AVAIL_WINDOWS if windows is None else windows,
        "slots": [] if slots is None else slots,
        "closures": [{"closedOn": x} for x in closures],
        "holidayDays": list(holidays),
        "occupied": [{"date": d, "slotKey": s, "count": n} for d, s, n in occupied],
        "hand": hand,
        "sqlConstraintRefusal": bool(
            config is not None
            and cfgkw.get("slotSelectionMode") == "time_within_window"
            and cfgkw.get("timeGranularityMinutes") is None),
    }
    if cfgkw.get("slotSelectionMode") == "fixed_slots" and slots is None:
        c["slots"] = AVAIL_SLOTS
        c["windows"] = []
    CASES.append(c)


# ── Cas-frontières (réponse à la main dans `hand`) ──────────────────────
add("v12-absent-no-row", "Aucune planification : parcours historique.", "2026-10-13T09:00:00+02:00",
    config=None, hand={"status": "absent"})
add("v12-absent-disabled", "Planification désactivée : absent.", "2026-10-13T09:00:00+02:00",
    enabled=False, hand={"status": "absent"})

# Mardi 13 oct. 2026, jour de préparation, limite 10:00, J+1.
add("v12-tue-before-cutoff-1s", "Mardi 09:59:59 < 10:00 : origine = mardi, J+1 = mercredi 14.",
    "2026-10-13T09:59:59+02:00", hand={"first": "2026-10-14"})
add("v12-tue-before-cutoff-ms", "Mardi 09:59:59.999 : encore avant la limite.",
    "2026-10-13T09:59:59.999+02:00", hand={"first": "2026-10-14"})
add("v12-tue-exact-cutoff", "Mardi 10:00:00 EXACT : la limite est ATTEINTE -> origine mercredi, J+1 = jeudi 15.",
    "2026-10-13T10:00:00+02:00", hand={"first": "2026-10-15"})
add("v12-tue-after-cutoff-1s", "Mardi 10:00:01 : limite atteinte.", "2026-10-13T10:00:01+02:00",
    hand={"first": "2026-10-15"})

# Samedi 17 : préparé, mais dimanche/lundi indisponibles pour le client.
add("v12-sat-before-cutoff", "Samedi 09:00 : origine samedi, J+1 = dimanche (fermé au client) -> avance au mardi 20.",
    "2026-10-17T09:00:00+02:00", hand={"first": "2026-10-20"})
add("v12-sat-exact-cutoff", "Samedi 10:00 EXACT : origine = prochain jour de préparation = lundi 19, J+1 = mardi 20.",
    "2026-10-17T10:00:00+02:00", hand={"first": "2026-10-20"})
add("v12-sat-after-cutoff", "Samedi 15:00 : origine lundi 19, J+1 = mardi 20.", "2026-10-17T15:00:00+02:00",
    hand={"first": "2026-10-20"})

# Dimanche 18 : jour SANS préparation -> la limite n'est pas consultée.
add("v12-sun-morning", "Dimanche 09:00 (pas de préparation) : origine lundi 19, J+1 = mardi 20.",
    "2026-10-18T09:00:00+02:00", hand={"first": "2026-10-20"})
add("v12-sun-late", "Dimanche 23:59 : même résultat (la limite n'est pas consultée).",
    "2026-10-18T23:59:00+02:00", hand={"first": "2026-10-20"})
add("v12-sun-with-prep-sunday-before-cutoff",
    "Si le dimanche EST un jour de préparation : 09:00 < 10:00 -> origine dimanche 18, J+1 = lundi 19 (fermé client) -> mardi 20.",
    "2026-10-18T09:00:00+02:00", prep=[0, 1, 2, 3, 4, 5, 6], hand={"first": "2026-10-20"})

# Lundi 19 : préparation ouverte, disponibilité fermée.
add("v12-mon-before-cutoff", "Lundi 09:00 : origine lundi, J+1 = mardi 20.", "2026-10-19T09:00:00+02:00",
    hand={"first": "2026-10-20"})
add("v12-mon-exact-cutoff", "Lundi 10:00 EXACT : origine mardi 20, J+1 = mercredi 21.",
    "2026-10-19T10:00:00+02:00", hand={"first": "2026-10-21"})

# Vendredi 16 après limite.
add("v12-fri-after-cutoff", "Vendredi 11:00 : origine samedi 17, J+1 = dimanche (fermé) -> mardi 20.",
    "2026-10-16T11:00:00+02:00", hand={"first": "2026-10-20"})

# J+X variés.
add("v12-j0-tue-morning", "J+0 mardi 09:00 : cible = aujourd'hui, les fenêtres de 11:00 sont encore à venir.",
    "2026-10-13T09:00:00+02:00", minLeadDays=0, hand={"first": "2026-10-13"})
add("v12-j0-mon-forward", "J+0 lundi 09:00 : cible lundi (fermé au client) -> avance au mardi 20.",
    "2026-10-19T09:00:00+02:00", minLeadDays=0, hand={"first": "2026-10-20"})
add("v12-j2-thu-after-cutoff", "J+2 jeudi 10:30 : origine vendredi 16, cible dimanche 18 -> avance au mardi 20.",
    "2026-10-15T10:30:00+02:00", minLeadDays=2, hand={"first": "2026-10-20"})
add("v12-j3-tue-before-cutoff", "J+3 mardi 09:00 : origine mardi 13, cible vendredi 16.",
    "2026-10-13T09:00:00+02:00", minLeadDays=3, hand={"first": "2026-10-16"})
add("v12-j1-no-cutoff", "Sans heure limite : origine = aujourd'hui (jour de préparation) à toute heure.",
    "2026-10-13T23:00:00+02:00", cutoffTime=None, hand={"first": "2026-10-14"})
add("v12-j1-no-cutoff-nonprep-day", "Sans limite, dimanche : origine = lundi 19, J+1 = mardi 20.",
    "2026-10-18T12:00:00+02:00", cutoffTime=None, hand={"first": "2026-10-20"})

# Fermetures exceptionnelles — DISPONIBILITÉ.
add("v12-avail-closure-on-target", "Fermeture de disponibilité mer. 14 : la cible avance au jeudi 15.",
    "2026-10-13T09:00:00+02:00", closures=["2026-10-14"], hand={"first": "2026-10-15"})
add("v12-avail-closure-two-days", "Mer. 14 et jeu. 15 fermés : avance au vendredi 16.",
    "2026-10-13T09:00:00+02:00", closures=["2026-10-14", "2026-10-15"], hand={"first": "2026-10-16"})
# Fermetures exceptionnelles — PRÉPARATION.
add("v12-prep-closure-today", "Préparation fermée aujourd'hui (mar. 13) : origine mercredi 14 (limite non consultée), J+1 = jeudi 15.",
    "2026-10-13T09:00:00+02:00", prep_closures=["2026-10-13"], hand={"first": "2026-10-15"})
add("v12-prep-closure-next-prep-day", "Après limite mardi 10:00, mercredi 14 fermé en préparation : origine jeudi 15, J+1 = vendredi 16.",
    "2026-10-13T10:00:00+02:00", prep_closures=["2026-10-14"], hand={"first": "2026-10-16"})
add("v12-prep-closure-not-availability",
    "Une fermeture de PRÉPARATION n'est pas une fermeture de DISPONIBILITÉ : mer. 14 fermé en préparation, mardi 09:00 -> origine mardi, cible mer. 14 reste disponible.",
    "2026-10-13T09:00:00+02:00", prep_closures=["2026-10-14"], hand={"first": "2026-10-14"})
add("v12-avail-closure-not-prep",
    "Une fermeture de DISPONIBILITÉ n'interdit pas la préparation : mer. 14 fermé au client, mardi 10:00 -> origine mercredi (préparation ouverte), cible jeudi 15.",
    "2026-10-13T10:00:00+02:00", closures=["2026-10-14"], hand={"first": "2026-10-15"})

# Jours fériés — calendrier SYNTHÉTIQUE.
add("v12-holiday-prep-closed", "Férié synthétique mer. 14, préparation « closed » : mardi 10:00 -> origine jeudi 15, J+1 = vendredi 16.",
    "2026-10-13T10:00:00+02:00", holidayCalendar=True, preparationOnHolidays="closed",
    holidays=["2026-10-14"], hand={"first": "2026-10-16"})
add("v12-holiday-avail-closed", "Férié synthétique mer. 14, disponibilité « closed » : cible mer. 14 -> avance au jeudi 15.",
    "2026-10-13T09:00:00+02:00", holidayCalendar=True, availabilityOnHolidays="closed",
    holidays=["2026-10-14"], hand={"first": "2026-10-15"})
add("v12-holiday-open-policy", "Calendrier rattaché mais politique « open » : le férié ne ferme RIEN.",
    "2026-10-13T09:00:00+02:00", holidayCalendar=True, holidays=["2026-10-14"], hand={"first": "2026-10-14"})
add("v12-holiday-prep-only-not-avail",
    "Préparation « closed » seule : mercredi 14 férié. Mardi 09:00 -> origine mardi, cible mer. 14 reste disponible (disponibilité « open »).",
    "2026-10-13T09:00:00+02:00", holidayCalendar=True, preparationOnHolidays="closed",
    holidays=["2026-10-14"], hand={"first": "2026-10-14"})
add("v12-holiday-both-closed", "Les deux politiques « closed », férié mer. 14 et jeu. 15 : mardi 10:00 -> origine vendredi 16, cible samedi 17.",
    "2026-10-13T10:00:00+02:00", holidayCalendar=True, preparationOnHolidays="closed",
    availabilityOnHolidays="closed", holidays=["2026-10-14", "2026-10-15"], hand={"first": "2026-10-17"})

# Configurations impossibles : refus NOMMÉ, jamais de date de repli.
add("v12-prep-calendar-missing", "Aucun jour de préparation configuré : impossible, nommé.",
    "2026-10-13T09:00:00+02:00", prep=[], hand={"status": "unfulfillable", "reason": "preparation_calendar_missing"})
add("v12-no-offer", "Aucune offre de disponibilité : no_offer_configured.",
    "2026-10-13T09:00:00+02:00", windows=[], hand={"status": "unfulfillable", "reason": "no_offer_configured"})
add("v12-granularity-missing", "Plage horaire sans granularité : granularity_missing.",
    "2026-10-13T09:00:00+02:00", slotSelectionMode="time_within_window",
    hand={"status": "unfulfillable", "reason": "granularity_missing"})
add("v12-informational-only", "Politique informative : aucune date calculée.",
    "2026-10-13T09:00:00+02:00", dateSelectionMode="informational_only", hand={"status": "informational_only"})
add("v12-no-prep-day-in-horizon", "Horizon de 2 jours, préparation le seul samedi : mardi 10:00 -> aucun jour de préparation.",
    "2026-10-13T10:00:00+02:00", prep=[6], bookingHorizonDays=2,
    hand={"status": "unfulfillable", "reason": "no_preparation_day_in_horizon"})
add("v12-target-beyond-horizon", "J+10 avec un horizon de 5 jours : la cible dépasse l'horizon.",
    "2026-10-13T09:00:00+02:00", minLeadDays=10, bookingHorizonDays=5,
    hand={"status": "unfulfillable", "reason": "horizon_exhausted"})
add("v12-all-dates-closed", "Toutes les dates offertes fermées : all_dates_closed.",
    "2026-10-13T09:00:00+02:00", bookingHorizonDays=3, closures=["2026-10-14", "2026-10-15", "2026-10-16"],
    hand={"status": "unfulfillable", "reason": "all_dates_closed"})
add("v12-no-offer-in-horizon", "Délai minute > horizon : les offres existent mais aucune n'est atteignable.",
    "2026-10-13T09:00:00+02:00", bookingHorizonDays=3, leadTimeMinutes=20160,
    hand={"status": "unfulfillable", "reason": "no_offer_in_horizon"})

# Heure limite sur heure murale invalide (fail-closed).
add("v12-cutoff-gap-paris", "Limite 02:30 le dimanche 28 mars 2027 (heure inexistante à Paris) : refus nommé, aucune date.",
    "2027-03-28T01:00:00+01:00", prep=[0, 1, 2, 3, 4, 5, 6], cutoffTime="02:30",
    hand={"status": "unfulfillable", "reason": "cutoff_unresolvable"})
add("v12-cutoff-overlap-paris", "Limite 02:30 le dimanche 25 oct. 2026 (heure ambiguë à Paris) : refus nommé.",
    "2026-10-25T01:00:00+02:00", prep=[0, 1, 2, 3, 4, 5, 6], cutoffTime="02:30",
    hand={"status": "unfulfillable", "reason": "cutoff_unresolvable"})
add("v12-cutoff-gap-ignored-on-nonprep-day",
    "Même limite invalide, mais dimanche NON préparé : la limite n'est pas consultée -> pas de refus.",
    "2027-03-28T01:00:00+01:00", prep=[1, 2, 3, 4, 5, 6], cutoffTime="02:30", hand={"first": "2027-03-30"})

# Fuseaux : « aujourd'hui » est une date LOCALE du commerçant.
add("v12-tz-paris-after-midnight", "22:30Z le 13 oct. = 00:30 le mardi 14 à Paris : « aujourd'hui » = mer. 14, avant la limite -> J+1 = jeu. 15.",
    "2026-10-13T22:30:00+00:00", hand={"first": "2026-10-15"})
add("v12-tz-newyork-same-instant", "Même instant à New York = 18:30 le mardi 13 : après la limite 10:00 -> origine mer. 14, J+1 = jeu. 15.",
    "2026-10-13T22:30:00+00:00", timezone="America/New_York", hand={"first": "2026-10-15"})
add("v12-tz-tokyo", "Asia/Tokyo, 00:30Z = 09:30 locale mardi 13 : avant la limite.",
    "2026-10-13T00:30:00+00:00", timezone="Asia/Tokyo", hand={"first": "2026-10-14"})
add("v12-tz-lord-howe", "Australia/Lord_Howe (décalage +10:30/+11) : 22:00Z le 12 oct. -> local 09:00 mar. 13 (+11), avant la limite.",
    "2026-10-12T22:00:00+00:00", timezone="Australia/Lord_Howe", hand={"first": "2026-10-14"})

# Créneaux fixes et plage horaire.
add("v12-slots-customer-selectable", "Créneaux fixes, date au choix du client : tous les créneaux de chaque date.",
    "2026-10-13T09:00:00+02:00", slotSelectionMode="fixed_slots", hand={"first": "2026-10-14"})
add("v12-derived-earliest", "Date dérivée (sans créneau) : la première date seulement.",
    "2026-10-13T09:00:00+02:00", dateSelectionMode="derived_earliest", hand={"first": "2026-10-14"})
add("v12-window-granularity", "Plage horaire à la demi-heure : première heure atteignable.",
    "2026-10-13T09:00:00+02:00", slotSelectionMode="time_within_window", timeGranularityMinutes=30,
    hand={"first": "2026-10-14"})
add("v12-window-dst-day", "Plage 01:30-03:30 le 28 mars 2027 (Paris, saut d'heure) : la grille traverse une heure inexistante -> écartée.",
    "2027-03-26T09:00:00+01:00", prep=[0, 1, 2, 3, 4, 5, 6], minLeadDays=2,
    windows=[{"weekday": 0, "startsAt": "01:30", "endsAt": "03:30"}] + AVAIL_WINDOWS,
    slotSelectionMode="time_within_window", timeGranularityMinutes=30, hand={})

# Capacité (occupations posées par le harnais ; aucun compte exposé).
add("v12-cap-off-ignores-occupancy", "Capacité DÉSACTIVÉE : l'occupation est ignorée.",
    "2026-10-13T09:00:00+02:00", occupied=[("2026-10-14", None, 99)], hand={"first": "2026-10-14"})
add("v12-cap-date-full", "Capacité 2 par date, mer. 14 pleine : la date est retirée, jeu. 15 première.",
    "2026-10-13T09:00:00+02:00", capacityEnabled=True, capacityMaxOrders=2,
    occupied=[("2026-10-14", None, 2)], hand={"first": "2026-10-15"})
add("v12-cap-date-one-left", "Capacité 2, une place restante mer. 14 : la date reste offerte.",
    "2026-10-13T09:00:00+02:00", capacityEnabled=True, capacityMaxOrders=2,
    occupied=[("2026-10-14", None, 1)], hand={"first": "2026-10-14"})
add("v12-cap-slot-full", "Capacité 1 par créneau, 11-14 plein mer. 14 : ce créneau est retiré, les autres restent.",
    "2026-10-13T09:00:00+02:00", slotSelectionMode="fixed_slots", capacityEnabled=True, capacityMaxOrders=1,
    occupied=[("2026-10-14", "11-14", 1)], hand={"first": "2026-10-14"})
add("v12-cap-all-slots-full-day", "Les trois créneaux de mer. 14 pleins : la date disparaît.",
    "2026-10-13T09:00:00+02:00", slotSelectionMode="fixed_slots", capacityEnabled=True, capacityMaxOrders=1,
    occupied=[("2026-10-14", "11-14", 1), ("2026-10-14", "14-17", 1), ("2026-10-14", "17-20", 1)],
    hand={"first": "2026-10-15"})
add("v12-cap-derived-skips-full", "Date dérivée : la première date PLEINE est sautée, la suivante est offerte.",
    "2026-10-13T09:00:00+02:00", dateSelectionMode="derived_earliest", capacityEnabled=True, capacityMaxOrders=1,
    occupied=[("2026-10-14", None, 1)], hand={"first": "2026-10-15"})
add("v12-cap-exhausted", "Toutes les dates de l'horizon pleines : capacity_exhausted, nommé.",
    "2026-10-13T09:00:00+02:00", bookingHorizonDays=3, capacityEnabled=True, capacityMaxOrders=1,
    occupied=[("2026-10-14", None, 1), ("2026-10-15", None, 1), ("2026-10-16", None, 1)],
    hand={"status": "unfulfillable", "reason": "capacity_exhausted"})
add("v12-cap-over-limit-occupancy", "Occupation SUPÉRIEURE au maximum (maximum abaissé après coup) : la date est pleine.",
    "2026-10-13T09:00:00+02:00", capacityEnabled=True, capacityMaxOrders=2,
    occupied=[("2026-10-14", None, 5)], hand={"first": "2026-10-15"})


def main():
    out = []
    for c in CASES:
        exp = resolve(c)
        hand = c.pop("hand")
        if hand is not None:
            if "status" in hand and hand["status"] != exp["status"]:
                sys.exit(f"ORACLE vs MAIN : {c['id']} statut {exp['status']} != {hand['status']}")
            if "reason" in hand and hand["reason"] != exp["reason"]:
                sys.exit(f"ORACLE vs MAIN : {c['id']} motif {exp['reason']} != {hand['reason']}")
            if "first" in hand and hand["first"] != exp["firstEligibleDate"]:
                sys.exit(f"ORACLE vs MAIN : {c['id']} première date {exp['firstEligibleDate']} != {hand['first']}")
        c["expected"] = exp
        c["handDerived"] = hand if hand else None
        out.append(c)

    doc = {
        "lot": "CSDJ v1.2 — calendriers, heure limite + J+X, jours fériés, capacité",
        "generator": "tests/fixtures/build-checkout-scheduling-v12-cases.py",
        "generatorCommand": "python3 -I tests/fixtures/build-checkout-scheduling-v12-cases.py",
        "generatorRuntime": {
            "python": platform.python_version(),
            "tzdata": getattr(zoneinfo, "TZPATH", None) and "system zoneinfo",
        },
        "oracleMethod": "Troisième implémentation indépendante (Python, zoneinfo/PEP 495). Les cas-frontières portent une réponse dérivée à la main (`handDerived`) que le générateur vérifie avant d'écrire.",
        "weekdayConvention": "0 = dimanche … 6 = samedi",
        "holidayNote": "Calendriers fériés SYNTHÉTIQUES de test. Aucune juridiction, aucun jeu de données réel.",
        "cases": out,
    }
    path = Path(__file__).with_name("checkout-scheduling-v12-cases.json")
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    kinds = {}
    for c in out:
        k = c["expected"]["status"] + ("/" + c["expected"]["reason"] if c["expected"]["reason"] else "")
        kinds[k] = kinds.get(k, 0) + 1
    print(f"{len(out)} cas écrits dans {path.name}")
    for k, v in sorted(kinds.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
