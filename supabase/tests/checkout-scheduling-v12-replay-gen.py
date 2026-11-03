#!/usr/bin/env python3
"""Rejoue tests/fixtures/checkout-scheduling-v12-cases.json contre SQL.

Usage : checkout-scheduling-v12-replay-gen.py FIXTURE SQL_OUT EXPECTED_OUT RID [FN]

Produit un script psql (une ligne canonique par cas) et la liste des
lignes attendues, tirées de l'ORACLE Python indépendant (jamais du SQL).
FN = fonction appelée (défaut : le répartiteur public-chemin
`public.resolve_fulfillment_schedule`).
"""
import json
import sys

fixture_path, sql_path, expected_path, rid = sys.argv[1:5]
fn = sys.argv[5] if len(sys.argv) > 5 else "public.resolve_fulfillment_schedule"
NIL = "00000000-0000-0000-0000-000000000000"
data = json.load(open(fixture_path, encoding="utf-8"))


def q(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"


sql = ["\\pset tuples_only on", "\\pset format unaligned"]
expected = []
refusals = []
out_dir = __import__("pathlib").Path(sql_path).parent
for c in data["cases"]:
    cid, cfg = c["id"], c["config"]
    if c.get("sqlConstraintRefusal"):
        # État que les contraintes de table (CSDJ-1) rendent inatteignable :
        # on prouve le REFUS d'insertion, on ne compare pas un calcul.
        blk = ["begin;",
               f"delete from public.restaurant_fulfillment_schedule where restaurant_id = '{rid}';",
               "insert into public.restaurant_fulfillment_schedule "
               "(restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, date_selection_mode, "
               "slot_selection_mode, time_granularity_minutes, lead_time_minutes, min_lead_days, cutoff_time, "
               "cutoff_offset_days, booking_horizon_days, schedule_method_version) values ("
               f"'{rid}', 'pickup', null, {q(cfg['timezone'])}, true, {q(cfg['dateSelectionMode'])}, "
               f"{q(cfg['slotSelectionMode'])}, {q(cfg['timeGranularityMinutes'])}, {cfg['leadTimeMinutes']}, "
               f"{cfg['minLeadDays']}, {q(cfg['cutoffTime'])}, 0, {cfg['bookingHorizonDays']}, 'v1.2');",
               "rollback;"]
        (out_dir / f"refusal-{cid}.sql").write_text("\n".join(blk) + "\n", encoding="utf-8")
        refusals.append(cid)
        continue
    sql.append(f"-- {cid}")
    sql.append(f"delete from public.order_fulfillment_capacity_reservation where restaurant_id = '{rid}';")
    sql.append(f"delete from public.orders where restaurant_id = '{rid}';")
    sql.append(f"delete from public.restaurant_fulfillment_schedule where restaurant_id = '{rid}';")
    sql.append("delete from public.public_holiday_calendar where code = 'csdj12-test-calendar';")
    if cfg is not None:
        cal = "null"
        if cfg["holidayCalendar"]:
            sql.append("insert into public.public_holiday_calendar (code, label) values ('csdj12-test-calendar', 'Calendrier synthétique de test');")
            for h in c["holidayDays"]:
                sql.append("insert into public.public_holiday_calendar_day (calendar_id, holiday_on, label) "
                           f"select id, '{h}', 'jour de test' from public.public_holiday_calendar where code = 'csdj12-test-calendar';")
            cal = "(select id from public.public_holiday_calendar where code = 'csdj12-test-calendar')"
        sql.append(
            "insert into public.restaurant_fulfillment_schedule "
            "(restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, date_selection_mode, "
            "slot_selection_mode, time_granularity_minutes, lead_time_minutes, min_lead_days, cutoff_time, "
            "cutoff_offset_days, booking_horizon_days, schedule_method_version, holiday_calendar_id, "
            "preparation_on_holidays, availability_on_holidays, capacity_enabled, capacity_max_orders) values ("
            f"'{rid}', 'pickup', null, {q(cfg['timezone'])}, {str(cfg['enabled']).lower()}, "
            f"{q(cfg['dateSelectionMode'])}, {q(cfg['slotSelectionMode'])}, {q(cfg['timeGranularityMinutes'])}, "
            f"{cfg['leadTimeMinutes']}, {cfg['minLeadDays']}, {q(cfg['cutoffTime'])}, 0, "
            f"{cfg['bookingHorizonDays']}, 'v1.2', {cal}, {q(cfg['preparationOnHolidays'])}, "
            f"{q(cfg['availabilityOnHolidays'])}, {str(cfg['capacityEnabled']).lower()}, "
            f"{q(cfg['capacityMaxOrders'])});")
        for d in c["prepWeekdays"]:
            sql.append("insert into public.restaurant_fulfillment_prep_day (restaurant_id, mode_code, rule_key, weekday) "
                       f"values ('{rid}', 'pickup', '{NIL}', {d});")
        for pc in c["prepClosures"]:
            sql.append("insert into public.restaurant_fulfillment_prep_closure (restaurant_id, mode_code, rule_key, closed_on) "
                       f"values ('{rid}', 'pickup', '{NIL}', {q(pc['closedOn'])});")
        for w in c["windows"]:
            sql.append("insert into public.restaurant_fulfillment_schedule_window "
                       "(restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ("
                       f"'{rid}', 'pickup', '{NIL}', {w['weekday']}, {q(w['startsAt'])}, {q(w['endsAt'])});")
        for s in c["slots"]:
            sql.append("insert into public.restaurant_fulfillment_schedule_slot "
                       "(restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ("
                       f"'{rid}', 'pickup', '{NIL}', {s['weekday']}, {q(s['slotKey'])}, {q(s['startsAt'])}, {q(s['endsAt'])});")
        for cl in c["closures"]:
            sql.append("insert into public.restaurant_fulfillment_schedule_closure "
                       "(restaurant_id, mode_code, rule_key, closed_on) values ("
                       f"'{rid}', 'pickup', '{NIL}', {q(cl['closedOn'])});")
        n = 0
        for o in c["occupied"]:
            for _ in range(o["count"]):
                n += 1
                sql.append(
                    "with o as (insert into public.orders (restaurant_id, order_number, service_mode, subtotal, total, currency) "
                    f"values ('{rid}', {n}, 'pickup', 1, 1, 'EUR') returning id) "
                    "insert into public.order_fulfillment_capacity_reservation "
                    "(order_id, restaurant_id, mode_code, rule_key, fulfillment_date, slot_key) "
                    f"select id, '{rid}', 'pickup', '{NIL}', '{o['date']}', {q(o['slotKey'] or '')} from o;")
    sql.append(
        f"select '{cid}|' || coalesce(status,'-') || '|' || coalesce(unfulfillable_reason,'-') || '|' || "
        "coalesce(first_eligible_date::text,'-') || '|' || coalesce(array_to_string(eligible_dates, ','),'-') || '|' || "
        "coalesce((select string_agg(d || '=' || ("
        "  select string_agg(coalesce(o->>'slot_key','*') || '@' || (o->>'starts_at') "
        "    || '-' || (o->>'ends_at'), ';' order by (o->>'starts_at'), coalesce(o->>'slot_key','')) "
        "  from jsonb_array_elements(offers -> d) o), ' ' order by d) "
        " from jsonb_object_keys(coalesce(offers,'{}'::jsonb)) d), '-') "
        f"from {fn}('{rid}', 'pickup', null, {q(c['nowIso'])}::timestamptz);")
    e = c["expected"]
    dates = ",".join(d["date"] for d in e["dates"]) or "-"
    offers = " ".join(
        d["date"] + "=" + ";".join((o["slotKey"] or "*") + "@" + o["startsAt"] + "-" + o["endsAt"]
                                   for o in sorted(d["offers"], key=lambda o: (o["startsAt"], o["slotKey"] or "")))
        for d in e["dates"]) or "-"
    expected.append("|".join([cid, e["status"], e["reason"] or "-", e["firstEligibleDate"] or "-", dates, offers]))

open(sql_path, "w", encoding="utf-8").write("\n".join(sql) + "\n")
open(expected_path, "w", encoding="utf-8").write("\n".join(expected) + "\n")
open(expected_path + ".refusals", "w", encoding="utf-8").write(("\n".join(refusals) + "\n") if refusals else "")
print(f"{len(expected)} cas générés, {len(refusals)} refus de contrainte")
