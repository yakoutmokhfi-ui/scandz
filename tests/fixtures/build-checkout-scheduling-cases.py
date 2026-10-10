#!/usr/bin/env python3
"""Génère tests/fixtures/checkout-scheduling-cases.json.

CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1) — TROISIÈME IMPLÉMENTATION.

Pourquoi ce fichier existe, et pourquoi il est VERSIONNÉ AU DÉPÔT
================================================================
La fixture partagée est rejouée par deux implémentations livrées :
`lib/scheduling/eligibility.ts` et `public.resolve_fulfillment_schedule`.
Si les ATTENDUS de cette fixture venaient de l'une des deux, cette
implémentation serait juge de sa propre sortie, et la « preuve croisée »
ne prouverait que leur accord mutuel.

Les attendus viennent donc d'ici : une troisième implémentation, écrite
dans un autre langage, qui lit la base de fuseaux du système par
`zoneinfo` et ne partage aucune ligne de code avec les deux autres.

L'audit indépendant a eu raison de refuser cette affirmation tant que
cette source n'était pas livrable et son exécution pas traçable. Elle
est désormais au dépôt, et le paquet de preuves porte la commande, le
journal d'exécution, la version de Python et celle de la base de
fuseaux. Qui veut vérifier relance :

    python3 -I tests/fixtures/build-checkout-scheduling-cases.py

et compare le fichier produit à celui du commit -- il doit être
identique à l'octet.

Ce fichier ne part PAS avec l'application : il n'est importé par aucun
module, et seul `tests/csdj1-sql-structural.test.ts` vérifie sa présence.

Politiques implémentées, identiques aux deux autres côtés
========================================================
CSDJ-V1-OFFER-START-INSTANT-01   chaque offre est comparée en INSTANT à
                                 l'instant minimal de réalisation
CSDJ-V1-WALL-TIME-FAIL-CLOSED-01 heure murale inexistante ou ambiguë :
                                 l'occurrence est écartée
CSDJ-V1-MINUTE-PRECISION-01      les secondes doivent valoir 00, sinon
                                 l'heure n'est pas admissible
"""
import datetime as dt
import json
import platform
import re
import sys
import zoneinfo
from pathlib import Path

NIL = None
HOUR = dt.timedelta(hours=1)


def dow(d: dt.date) -> int:
    """0 = dimanche, comme extract(dow) et Date#getUTCDay."""
    return (d.weekday() + 1) % 7


def parse_time(s):
    """Minutes depuis minuit, ou None si l'heure n'est pas admissible.

    CSDJ-V1-MINUTE-PRECISION-01 : les secondes doivent valoir 00.
    """
    if s is None or not isinstance(s, str):
        return None
    m = re.fullmatch(r"(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?", s)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    sec = int(m.group(3)) if m.group(3) else 0
    frac = m.group(4)
    if h > 23 or mi > 59 or sec != 0:
        return None
    if frac and any(c != "0" for c in frac):
        return None
    return h * 60 + mi


def fmt(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def resolve_wall(d: dt.date, minutes: int, tz: str):
    """('ok'|'nonexistent'|'ambiguous', instant ou None).

    `fold` de la bibliothèque standard donne les deux occurrences d'une
    heure ambiguë ; un aller-retour détecte une heure inexistante.
    """
    z = zoneinfo.ZoneInfo(tz)
    naive = dt.datetime(d.year, d.month, d.day, minutes // 60, minutes % 60)
    a = naive.replace(tzinfo=z, fold=0)
    b = naive.replace(tzinfo=z, fold=1)
    # Heure AMBIGUË : les deux « plis » désignent deux instants réels
    # distincts portant la même heure murale.
    if a.utcoffset() != b.utcoffset():
        if a.astimezone(dt.timezone.utc).astimezone(z).replace(tzinfo=None) == naive and \
           b.astimezone(dt.timezone.utc).astimezone(z).replace(tzinfo=None) == naive:
            return "ambiguous", None
        # Les deux plis diffèrent mais l'heure murale ne se relit pas :
        # c'est le trou du saut de printemps.
        return "nonexistent", None
    # Heure INEXISTANTE : l'aller-retour ne rend pas l'heure demandée.
    if a.astimezone(dt.timezone.utc).astimezone(z).replace(tzinfo=None) != naive:
        return "nonexistent", None
    return "ok", a


def resolve(case):
    cfg = case["config"]
    if cfg is None or cfg.get("enabled") is not True:
        return {"status": "absent", "reason": NIL, "firstEligibleDate": NIL, "dates": []}

    date_mode = cfg["dateSelectionMode"]
    slot_mode = cfg["slotSelectionMode"]
    if not (date_mode == "customer_selectable" or slot_mode == "none"):
        return {"status": "unfulfillable", "reason": "no_offer_configured",
                "firstEligibleDate": NIL, "dates": []}

    if date_mode == "informational_only":
        return {"status": "informational_only", "reason": NIL,
                "firstEligibleDate": NIL, "dates": []}

    granularity = cfg.get("timeGranularityMinutes")
    if slot_mode == "time_within_window" and granularity is None:
        return {"status": "unfulfillable", "reason": "granularity_missing",
                "firstEligibleDate": NIL, "dates": []}

    uses_slots = slot_mode == "fixed_slots"
    offers = {}
    if uses_slots:
        for s in case["slots"]:
            if parse_time(s["startsAt"]) is None or parse_time(s["endsAt"]) is None:
                continue
            offers.setdefault(s["weekday"], []).append(
                {"slotKey": s["slotKey"], "startsAt": s["startsAt"], "endsAt": s["endsAt"]})
    else:
        for w in case["windows"]:
            if parse_time(w["startsAt"]) is None or parse_time(w["endsAt"]) is None:
                continue
            offers.setdefault(w["weekday"], []).append(
                {"slotKey": NIL, "startsAt": w["startsAt"], "endsAt": w["endsAt"]})
    for lst in offers.values():
        lst.sort(key=lambda o: (o["startsAt"], o["slotKey"] or ""))

    # Une offre dont l'heure n'est pas admissible n'existe pas : si plus
    # aucune ne reste, c'est bien « aucune offre configurée ».
    if not offers:
        return {"status": "unfulfillable", "reason": "no_offer_configured",
                "firstEligibleDate": NIL, "dates": []}

    tz = cfg["timezone"]
    z = zoneinfo.ZoneInfo(tz)
    now = dt.datetime.fromisoformat(case["nowIso"])
    today = now.astimezone(z).date()
    start = today + dt.timedelta(days=cfg["minLeadDays"])
    last = today + dt.timedelta(days=cfg["bookingHorizonDays"])

    # CSDJ-V1-OFFER-START-INSTANT-01
    floor_status, floor_instant = resolve_wall(start, 0, tz)
    from_lead = now + dt.timedelta(minutes=cfg["leadTimeMinutes"])
    min_instant = from_lead
    if floor_instant is not None and floor_instant > from_lead:
        min_instant = floor_instant

    cutoff_min = parse_time(cfg.get("cutoffTime"))
    closed = {c["closedOn"] for c in case["closures"]}

    eligible = []
    saw_closure = False
    saw_open_date = False
    d = start
    while d <= last:
        day_offers = offers.get(dow(d))
        if not day_offers:
            d += dt.timedelta(days=1)
            continue
        if d.isoformat() in closed:
            saw_closure = True
            d += dt.timedelta(days=1)
            continue
        if cutoff_min is not None:
            cd = d - dt.timedelta(days=cfg["cutoffOffsetDays"])
            status, instant = resolve_wall(cd, cutoff_min, tz)
            if instant is None or now >= instant:
                d += dt.timedelta(days=1)
                continue
        saw_open_date = True

        usable = []
        for o in day_offers:
            smin, emin = parse_time(o["startsAt"]), parse_time(o["endsAt"])
            if slot_mode == "time_within_window":
                chosen = None
                t = smin
                while t < emin:
                    status, instant = resolve_wall(d, t, tz)
                    if instant is not None and instant >= min_instant:
                        chosen = t
                        break
                    t += granularity
                if chosen is None:
                    continue
                usable.append({"slotKey": NIL, "startsAt": fmt(chosen), "endsAt": fmt(emin)})
                continue
            status, instant = resolve_wall(d, smin, tz)
            if instant is None or instant < min_instant:
                continue
            usable.append({"slotKey": o["slotKey"], "startsAt": fmt(smin), "endsAt": fmt(emin)})

        if not usable:
            d += dt.timedelta(days=1)
            continue

        eligible.append({"date": d.isoformat(), "offers": usable})
        if date_mode == "derived_earliest":
            break
        d += dt.timedelta(days=1)

    if not eligible:
        reason = ("no_offer_in_horizon" if saw_open_date
                  else "all_dates_closed" if saw_closure
                  else "horizon_exhausted")
        return {"status": "unfulfillable", "reason": reason,
                "firstEligibleDate": NIL, "dates": []}
    return {"status": "dates_available", "reason": NIL,
            "firstEligibleDate": eligible[0]["date"], "dates": eligible}


def violates_table_constraint(case):
    """L'état est-il INTERDIT par les contraintes de la table ?

    Ces cas existent pour prouver que le CALCUL refuse quand même, mais
    ils ne peuvent pas être INSÉRÉS côté SQL -- et c'est la preuve la
    plus forte : la base rend l'état impossible. Le harnais assertera
    donc le REFUS d'insertion au lieu de comparer un résultat.
    """
    cfg = case["config"]
    if cfg is None:
        return False
    coherent = (cfg["dateSelectionMode"] == "customer_selectable"
                or cfg["slotSelectionMode"] == "none")
    granularity_ok = (cfg["slotSelectionMode"] != "time_within_window"
                      or cfg.get("timeGranularityMinutes") is not None)
    times_ok = all(
        parse_time(v) is not None
        for rows, keys in ((case["windows"], ("startsAt", "endsAt")),
                           (case["slots"], ("startsAt", "endsAt")))
        for row in rows for v in (row[k] for k in keys)
    )
    if cfg.get("cutoffTime") is not None and parse_time(cfg["cutoffTime"]) is None:
        times_ok = False
    return not (coherent and granularity_ok and times_ok)


# ── Jeux d'offres réutilisés ────────────────────────────────────────────
PICKUP_WINDOWS = (
    [{"weekday": d, "startsAt": "11:00", "endsAt": "14:00"} for d in (2, 3, 4, 5)]
    + [{"weekday": d, "startsAt": "16:00", "endsAt": "20:00"} for d in (2, 3, 4, 5)]
    + [{"weekday": 6, "startsAt": "11:00", "endsAt": "19:30"}]
)

LOCAL_SLOTS = [
    {"weekday": d, "slotKey": k, "startsAt": s, "endsAt": e}
    for d in (2, 3, 4, 5, 6)
    for k, s, e in (("11-14", "11:00", "14:00"),
                    ("14-17", "14:00", "17:00"),
                    ("17-20", "17:00", "20:00"))
]

# Trois créneaux encadrant une transition d'heure, posés le DIMANCHE
# (weekday 0) : c'est le jour où les deux bascules européennes et
# américaines ont lieu.
DST_SLOTS = [
    {"weekday": 0, "slotKey": "t0159", "startsAt": "01:59", "endsAt": "02:00"},
    {"weekday": 0, "slotKey": "t0210", "startsAt": "02:10", "endsAt": "02:50"},
    {"weekday": 0, "slotKey": "t0330", "startsAt": "03:30", "endsAt": "04:30"},
]


def pickup_cfg(**over):
    cfg = {
        "timezone": "Europe/Paris", "enabled": True,
        "dateSelectionMode": "customer_selectable",
        "slotSelectionMode": "time_within_window",
        "timeGranularityMinutes": 15,
        "leadTimeMinutes": 0, "minLeadDays": 0,
        "cutoffTime": "16:00", "cutoffOffsetDays": 1,
        "bookingHorizonDays": 14,
    }
    cfg.update(over)
    return cfg


def local_cfg(**over):
    cfg = {
        "timezone": "Europe/Paris", "enabled": True,
        "dateSelectionMode": "customer_selectable",
        "slotSelectionMode": "fixed_slots",
        "timeGranularityMinutes": None,
        "leadTimeMinutes": 0, "minLeadDays": 1,
        "cutoffTime": "16:00", "cutoffOffsetDays": 1,
        "bookingHorizonDays": 10,
    }
    cfg.update(over)
    return cfg


def slot_cfg(**over):
    """Créneaux nommés, sans heure limite : isole le filtre d'INSTANT."""
    cfg = {
        "timezone": "Europe/Paris", "enabled": True,
        "dateSelectionMode": "customer_selectable",
        "slotSelectionMode": "fixed_slots",
        "timeGranularityMinutes": None,
        "leadTimeMinutes": 0, "minLeadDays": 0,
        "cutoffTime": None, "cutoffOffsetDays": 1,
        "bookingHorizonDays": 3,
    }
    cfg.update(over)
    return cfg


CASES = []


def case(cid, note, config, nowIso, windows=(), slots=(), closures=()):
    CASES.append({
        "id": cid, "note": note, "config": config, "nowIso": nowIso,
        "windows": list(windows), "slots": list(slots),
        "closures": [{"closedOn": c} for c in closures],
    })


# ── A. Absence et désactivation : CSDJ-V1-SCHEDULE-ABSENT-01 ───────────
case("absent-no-row",
     "Aucune planification configurée : le parcours reste celui d'avant le lot.",
     None, "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)
case("absent-disabled",
     "Planification complète mais enabled=false : MÊME état observable qu'une absence.",
     pickup_cfg(enabled=False), "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)

# ── B. Retrait §D : date + heure dans une fenêtre ──────────────────────
case("pickup-first-eligible-before-cutoff",
     "Mardi 09:00. L'heure limite de mercredi (mardi 16:00) n'est pas passée : la "
     "première date éligible est mercredi, pas aujourd'hui -- l'heure limite "
     "d'aujourd'hui était hier 16:00.",
     pickup_cfg(), "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)
case("pickup-cutoff-boundary-one-second-before",
     "Mardi 15:59:59 : mercredi est encore éligible.",
     pickup_cfg(), "2026-10-13T15:59:59+02:00", PICKUP_WINDOWS)
case("pickup-cutoff-boundary-exact",
     "Mardi 16:00:00 PILE : trop tard pour mercredi. Une limite qu'on peut "
     "atteindre pile n'est pas une limite.",
     pickup_cfg(), "2026-10-13T16:00:00+02:00", PICKUP_WINDOWS)
case("pickup-weekly-closed-days",
     "Vendredi 09:00 : samedi éligible, dimanche et lundi SANS fenêtre donc "
     "absents de la liste, reprise mardi.",
     pickup_cfg(bookingHorizonDays=7), "2026-10-16T09:00:00+02:00", PICKUP_WINDOWS)
case("pickup-exceptional-closure",
     "Mercredi fermé exceptionnellement : la première date devient jeudi.",
     pickup_cfg(), "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS,
     closures=["2026-10-14"])
case("pickup-lead-time-pushes-day",
     "Délai de préparation de 2880 minutes (48 h) : la première date est "
     "repoussée de deux jours, par le DÉLAI et non par l'heure limite.",
     pickup_cfg(leadTimeMinutes=2880, cutoffTime=None),
     "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)
case("pickup-window-clipped-by-lead-time",
     "Mardi 12:30 sans heure limite : la fenêtre 11:00-14:00 du jour est "
     "AVANCÉE au premier point de grille utilisable (12:30), la fenêtre "
     "16:00-20:00 reste entière, et les jours suivants sont intacts. La part "
     "passée d'une fenêtre n'est pas proposée, et aucun créneau n'est inventé.",
     pickup_cfg(cutoffTime=None, bookingHorizonDays=2),
     "2026-10-13T12:30:00+02:00", PICKUP_WINDOWS)

# ── C. Livraison locale §E : créneaux fixes de 3 h, pas de jour même ───
case("local-fixed-slots-no-same-day",
     "Mardi 09:00, minLeadDays=1 : pas de livraison le jour même, et l'heure "
     "limite de la veille écarte aussi mercredi.",
     local_cfg(), "2026-10-13T09:00:00+02:00", slots=LOCAL_SLOTS)
case("local-fixed-slots-after-cutoff",
     "Mardi 16:30, après l'heure limite : mercredi tombe, jeudi devient la "
     "première date.",
     local_cfg(), "2026-10-13T16:30:00+02:00", slots=LOCAL_SLOTS)

# ── D. CSDJ1-AUD-01 — filtrage par INSTANT ────────────────────────────
# CSDJ-V1-OFFER-START-INSTANT-01. Reproduction exacte de l'audit, puis
# les bornes à la seconde.
case("aud01-reproduction-past-slot-with-lead-time",
     "REPRODUCTION DE L'AUDIT : créneau 09:00-11:00, délai 120 minutes, il est "
     "15:00. Le créneau ne doit PAS être proposé. La version précédente le "
     "proposait, parce qu'elle ne comparait que des DATES.",
     slot_cfg(leadTimeMinutes=120, bookingHorizonDays=0),
     "2026-10-13T15:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "0900-1100", "startsAt": "09:00", "endsAt": "11:00"}])
case("aud01-slot-entirely-past",
     "Créneau entièrement passé, sans aucun délai : écarté.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T15:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "0900-1100", "startsAt": "09:00", "endsAt": "11:00"}])
case("aud01-slot-started-not-ended",
     "Créneau COMMENCÉ mais pas fini (14:00-16:00, il est 15:00) : écarté. Un "
     "créneau déjà entamé n'est pas honorable en entier ; le proposer serait "
     "promettre ce qu'on ne peut plus tenir.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T15:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "1400-1600", "startsAt": "14:00", "endsAt": "16:00"}])
case("aud01-slot-starts-one-second-before-threshold",
     "Le créneau commence UNE SECONDE avant le seuil : écarté.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T10:00:01+02:00",
     slots=[{"weekday": 2, "slotKey": "1000-1200", "startsAt": "10:00", "endsAt": "12:00"}])
case("aud01-slot-starts-exactly-at-threshold",
     "Le créneau commence EXACTEMENT au seuil : conservé. La comparaison est "
     "inclusive -- un créneau qui commence à l'instant minimal est réalisable.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T10:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "1000-1200", "startsAt": "10:00", "endsAt": "12:00"}])
case("aud01-slot-starts-after-threshold",
     "Le seuil est une seconde avant le début du créneau : conservé.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T09:59:59+02:00",
     slots=[{"weekday": 2, "slotKey": "1000-1200", "startsAt": "10:00", "endsAt": "12:00"}])
case("aud01-all-offers-removed-unfulfillable",
     "Toutes les offres du seul jour ouvert sont passées : statut "
     "`unfulfillable` avec le motif `no_offer_in_horizon` -- des dates étaient "
     "ouvertes, ce sont les OFFRES qui ne tenaient plus. Jamais une date de "
     "repli.",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T21:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "0900-1100", "startsAt": "09:00", "endsAt": "11:00"},
            {"weekday": 2, "slotKey": "1400-1600", "startsAt": "14:00", "endsAt": "16:00"}])
case("aud01-future-day-remains-valid",
     "Les offres d'aujourd'hui sont passées, mais le jour suivant reste "
     "entièrement valide : le filtre d'instant retire des offres, il ne ferme "
     "pas l'horizon.",
     slot_cfg(bookingHorizonDays=1), "2026-10-13T21:00:00+02:00",
     slots=[{"weekday": 2, "slotKey": "0900-1100", "startsAt": "09:00", "endsAt": "11:00"},
            {"weekday": 3, "slotKey": "0900-1100", "startsAt": "09:00", "endsAt": "11:00"}])

# ── E. CSDJ1-AUD-02 — politique de changement d'heure ─────────────────
# CSDJ-V1-WALL-TIME-FAIL-CLOSED-01. Les créneaux encadrent la bascule :
# 01:59 existe, 02:10 non (printemps) ou deux fois (automne), 03:30
# existe.
case("aud02-paris-spring-forward-nonexistent-rejected",
     "Europe/Paris, dimanche 29 mars 2026 : 02:00-03:00 n'existe pas. Le "
     "créneau 01:59 est conservé, 02:10-02:50 est REJETÉ, 03:30 est conservé. "
     "La normalisation de PostgreSQL n'est pas une politique commerciale.",
     slot_cfg(bookingHorizonDays=2), "2026-03-28T12:00:00+01:00", slots=DST_SLOTS)
case("aud02-paris-autumn-fallback-ambiguous-rejected",
     "Europe/Paris, dimanche 25 octobre 2026 : 02:00-03:00 a lieu DEUX fois. "
     "Le créneau 02:10 est REJETÉ -- promettre 02:10 désignerait deux instants "
     "distants d'une heure, et personne n'aurait choisi lequel.",
     slot_cfg(bookingHorizonDays=2), "2026-10-24T12:00:00+02:00", slots=DST_SLOTS)
case("aud02-utc-no-transition",
     "UTC n'a aucune transition : les trois créneaux sont conservés.",
     slot_cfg(timezone="UTC", bookingHorizonDays=2),
     "2026-03-28T12:00:00+00:00", slots=DST_SLOTS)
case("aud02-utc-plus-14-no-transition",
     "Pacific/Kiritimati (UTC+14) n'a aucune transition : les trois créneaux "
     "sont conservés, et la date civile est celle du commerçant.",
     slot_cfg(timezone="Pacific/Kiritimati", bookingHorizonDays=2),
     "2026-03-28T00:00:00+00:00", slots=DST_SLOTS)
case("aud02-negative-offset-spring-forward",
     "America/Los_Angeles (décalage négatif), dimanche 8 mars 2026 : même "
     "politique, même rejet de l'heure inexistante.",
     slot_cfg(timezone="America/Los_Angeles", bookingHorizonDays=2),
     "2026-03-07T12:00:00-08:00", slots=DST_SLOTS)
case("aud02-negative-offset-autumn-fallback",
     "America/Los_Angeles, dimanche 1er novembre 2026 : heure ambiguë rejetée.",
     slot_cfg(timezone="America/Los_Angeles", bookingHorizonDays=2),
     "2026-10-31T12:00:00-07:00", slots=DST_SLOTS)

# ── F. Transporteur §F : informatif, ou date dérivée ───────────────────
case("carrier-informational-only",
     "Politique purement informative : AUCUNE date n'est montrée ni dérivée. "
     "C'est le transporteur qui ne sait pas s'engager -- et ne rien inventer "
     "est ici le comportement correct.",
     pickup_cfg(dateSelectionMode="informational_only",
                slotSelectionMode="none", timeGranularityMinutes=None),
     "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)
case("carrier-derived-earliest",
     "Date dérivée : le serveur en rend UNE seule, la première réellement "
     "éligible, et le client ne choisit pas.",
     pickup_cfg(dateSelectionMode="derived_earliest", slotSelectionMode="none",
                timeGranularityMinutes=None, minLeadDays=2),
     "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)

# ── G. Configuré mais infaisable : CSDJ-V1-UNFULFILLABLE-EXPLICIT-01 ───
case("unfulfillable-no-offer",
     "Activée, politique exigeant une date, AUCUNE fenêtre : échec explicite, "
     "jamais une date inventée.",
     pickup_cfg(), "2026-10-13T09:00:00+02:00", windows=[])
case("unfulfillable-all-closed",
     "Des fenêtres existent, mais chaque date de l'horizon est fermée : le "
     "motif dit « tout est fermé », qui se corrige en retirant une fermeture.",
     pickup_cfg(bookingHorizonDays=3), "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS,
     closures=["2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"])
case("unfulfillable-horizon-exhausted",
     "Minimum de 30 jours pour un horizon de 14 : le motif dit « horizon "
     "épuisé », qui se corrige en allongeant l'horizon.",
     pickup_cfg(minLeadDays=30, bookingHorizonDays=14),
     "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)

# ── H. Fuseaux ────────────────────────────────────────────────────────
case("tz-autumn-dst-boundary",
     "Samedi 2026-10-24 15:00, la veille du recul d'heure à Paris : l'heure "
     "limite du 26 est le 25 à 16:00, c'est-à-dire APRÈS la bascule, donc en "
     "UTC+1. Prouve que la bascule ne décale pas d'un jour.",
     pickup_cfg(bookingHorizonDays=5), "2026-10-24T15:00:00+02:00", PICKUP_WINDOWS)
case("tz-spring-dst-boundary",
     "Samedi 2026-03-28 15:00, la veille du saut de printemps.",
     pickup_cfg(bookingHorizonDays=5), "2026-03-28T15:00:00+01:00", PICKUP_WINDOWS)
case("tz-far-east-of-utc",
     "Pacific/Kiritimati (UTC+14) : à 12:00 UTC le 13, le commerçant est DÉJÀ "
     "au 14. La date civile lue est celle du COMMERÇANT, jamais celle d'UTC "
     "ni celle du client.",
     pickup_cfg(timezone="Pacific/Kiritimati", cutoffTime=None,
                bookingHorizonDays=4),
     "2026-10-13T12:00:00+00:00", PICKUP_WINDOWS)
case("tz-west-of-utc",
     "America/Los_Angeles : à 02:00 UTC le 14, le commerçant est ENCORE au 13.",
     pickup_cfg(timezone="America/Los_Angeles", cutoffTime=None,
                bookingHorizonDays=4),
     "2026-10-14T02:00:00+00:00", PICKUP_WINDOWS)

# ── I. États que les CONTRAINTES DE TABLE rendent impossibles ─────────
case("unfulfillable-granularity-missing",
     "`time_within_window` sans granularité : refus plutôt que choisir une "
     "grille à la place du commerçant. La contrainte de table l'interdit déjà ; "
     "ce cas prouve que le calcul refuse quand même.",
     pickup_cfg(timeGranularityMinutes=None),
     "2026-10-13T09:00:00+02:00", PICKUP_WINDOWS)
case("aud04-subminute-offer-not-admissible",
     "Créneau 09:00:30-11:00:30 : précision sous la minute. Le calcul écarte "
     "l'offre au lieu de la tronquer -- la tronquer produirait 09:00-11:00, "
     "soit une offre que la configuration ne décrit pas. La contrainte de table "
     "l'interdit aussi (CSDJ-V1-MINUTE-PRECISION-01).",
     slot_cfg(bookingHorizonDays=0), "2026-10-13T00:30:00+02:00",
     slots=[{"weekday": 2, "slotKey": "0900-1100", "startsAt": "09:00:30",
             "endsAt": "11:00:30"}])

for c in CASES:
    c["expected"] = resolve(c)
    c["sqlConstraintRefusal"] = violates_table_constraint(c)

TZ_VERSION = "inconnue"
for probe in ("/usr/share/zoneinfo/tzdata.zi", "/usr/share/zoneinfo/+VERSION"):
    try:
        first = Path(probe).read_text(encoding="utf-8").splitlines()[0].strip()
        TZ_VERSION = first.replace("# version ", "")
        break
    except OSError:
        continue

out = {
    "lot": "CHECKOUT SCHEDULING FOUNDATION v1 (CSDJ-1)",
    "generator": "tests/fixtures/build-checkout-scheduling-cases.py",
    "generatorCommand": "python3 -I tests/fixtures/build-checkout-scheduling-cases.py",
    "generatorRuntime": {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "tzdataVersion": TZ_VERSION,
        "tzpath": list(zoneinfo.TZPATH),
    },
    "contract": (
        "FIXTURE PARTAGÉE. Chaque cas est joué par DEUX implémentations livrées : "
        "lib/scheduling/eligibility.ts (tests/csdj1-scheduling-eligibility.test.ts) "
        "et public.resolve_fulfillment_schedule (supabase/tests/"
        "checkout-scheduling-foundation-v1-check.sh). Les attendus ont été "
        "produits par une TROISIÈME implémentation, versionnée au dépôt sous "
        "tests/fixtures/build-checkout-scheduling-cases.py, afin qu'aucune des "
        "deux implémentations livrées ne soit juge de sa propre sortie. "
        "Relancer le générateur doit reproduire ce fichier à l'octet."
    ),
    "weekdayConvention": "0 = dimanche, 6 = samedi (extract(dow) et Date#getUTCDay)",
    "policies": {
        "CSDJ-V1-OFFER-START-INSTANT-01": (
            "Chaque offre est comparée en INSTANT à max(now + lead_time_minutes, "
            "début de (today + min_lead_days) dans le fuseau). Une offre dont le "
            "DÉBUT tombe avant est écartée, y compris un créneau déjà commencé. "
            "Pour time_within_window, le début est avancé le long de la grille de "
            "granularité jusqu'au premier point utilisable ; si la grille sort de "
            "la fenêtre, la fenêtre disparaît. Aucune offre n'est fabriquée."
        ),
        "CSDJ-V1-WALL-TIME-FAIL-CLOSED-01": (
            "Une heure murale locale INEXISTANTE (saut de printemps) ou AMBIGUË "
            "(recul d'automne) ne désigne pas un instant unique : l'occurrence est "
            "ÉCARTÉE, jamais normalisée en silence. Le refus porte sur "
            "l'occurrence d'une date, pas sur la configuration : la même fenêtre "
            "reste valide les 364 autres jours."
        ),
        "CSDJ-V1-MINUTE-PRECISION-01": (
            "Toute heure de configuration est à la minute, secondes exactement 00. "
            "Une valeur sous-minute est REFUSÉE, jamais tronquée : tronquer "
            "09:00:30-09:00:59 produirait une offre de durée nulle affichée comme "
            "disponible."
        ),
    },
    "sqlConstraintRefusalNote": (
        "Un cas marqué `sqlConstraintRefusal` décrit un état que les CONTRAINTES "
        "DE TABLE rendent impossible. Le TypeScript le joue quand même, pour "
        "prouver que le calcul refuse au lieu de deviner ; le harnais SQL, lui, "
        "prouve que l'INSERTION est refusée -- preuve plus forte encore, puisque "
        "l'état n'est pas seulement mal calculé, il est inatteignable."
    ),
    "cases": CASES,
}

path = Path(__file__).resolve().parent / "checkout-scheduling-cases.json"
path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"python {platform.python_version()} / tzdata {TZ_VERSION}")
print(f"{len(CASES)} cas écrits dans {path}")
refused = [c["id"] for c in CASES if c["sqlConstraintRefusal"]]
print(f"dont {len(refused)} refusés par contrainte de table : {', '.join(refused)}")
for c in CASES:
    e = c["expected"]
    print(f"  {c['id']:48s} {e['status']:19s} {e['reason'] or '-':20s} "
          f"first={e['firstEligibleDate'] or '-':11s} n={len(e['dates'])}")
sys.exit(0)
