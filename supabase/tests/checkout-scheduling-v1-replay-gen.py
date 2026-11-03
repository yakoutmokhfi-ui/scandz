#!/usr/bin/env python3
"""Rejoue la fixture CSDJ-1 (v1) contre public.resolve_fulfillment_schedule.

Extrait MÉCANIQUEMENT du harnais CSDJ-1 (checkout-scheduling-foundation-v1-check.sh, section [6]), sans modification de logique : sert à comparer le comportement v1 AVANT et APRÈS la migration v1.2.
Usage : FIXTURE SQL_OUT EXPECTED_OUT RID NIL_RULE
"""
import json, sys
from pathlib import Path

fixture_path, sql_path, expected_path, rid, nil_rule = sys.argv[1:6]
data = json.load(open(fixture_path, encoding="utf-8"))

def q(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"

sql_lines = ["\\pset tuples_only on", "\\pset format unaligned"]
expected_lines = []

refusal_lines = []

for c in data["cases"]:
    cid = c["id"]
    cfg = c["config"]
    if c.get("sqlConstraintRefusal"):
        # État que les CONTRAINTES DE TABLE rendent impossible. On prouve
        # le REFUS d'insertion du JEU COMPLET -- la violation peut porter
        # sur la ligne de planification, sur une FENÊTRE ou sur un
        # CRÉNEAU, et n'en tester qu'une partie laisserait un faux
        # positif.
        block = [
            "begin;",
            f"delete from public.restaurant_fulfillment_schedule where restaurant_id = '{rid}';",
            "insert into public.restaurant_fulfillment_schedule "
            "(restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, "
            "date_selection_mode, slot_selection_mode, time_granularity_minutes, "
            "lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days, "
            "booking_horizon_days) values ("
            f"'{rid}', 'pickup', null, {q(cfg['timezone'])}, {str(cfg['enabled']).lower()}, "
            f"{q(cfg['dateSelectionMode'])}, {q(cfg['slotSelectionMode'])}, "
            f"{q(cfg['timeGranularityMinutes'])}, {cfg['leadTimeMinutes']}, "
            f"{cfg['minLeadDays']}, {q(cfg['cutoffTime'])}, {cfg['cutoffOffsetDays']}, "
            f"{cfg['bookingHorizonDays']});",
        ]
        for w in c["windows"]:
            block.append(
                "insert into public.restaurant_fulfillment_schedule_window "
                "(restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {w['weekday']}, "
                f"{q(w['startsAt'])}, {q(w['endsAt'])});")
        for sl in c["slots"]:
            block.append(
                "insert into public.restaurant_fulfillment_schedule_slot "
                "(restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {sl['weekday']}, {q(sl['slotKey'])}, "
                f"{q(sl['startsAt'])}, {q(sl['endsAt'])});")
        block.append("rollback;")
        (Path(sql_path).parent / f"refusal-{cid}.sql").write_text(
            "\n".join(block) + "\n", encoding="utf-8")
        refusal_lines.append(cid)
        continue
    sql_lines.append(f"-- {cid}")
    sql_lines.append(
        f"delete from public.restaurant_fulfillment_schedule where restaurant_id = '{rid}';")
    if cfg is not None:
        sql_lines.append(
            "insert into public.restaurant_fulfillment_schedule "
            "(restaurant_id, mode_code, fulfillment_rule_id, timezone, enabled, "
            "date_selection_mode, slot_selection_mode, time_granularity_minutes, "
            "lead_time_minutes, min_lead_days, cutoff_time, cutoff_offset_days, "
            "booking_horizon_days) values ("
            f"'{rid}', 'pickup', null, {q(cfg['timezone'])}, {str(cfg['enabled']).lower()}, "
            f"{q(cfg['dateSelectionMode'])}, {q(cfg['slotSelectionMode'])}, "
            f"{q(cfg['timeGranularityMinutes'])}, {cfg['leadTimeMinutes']}, "
            f"{cfg['minLeadDays']}, {q(cfg['cutoffTime'])}, {cfg['cutoffOffsetDays']}, "
            f"{cfg['bookingHorizonDays']});")
        for w in c["windows"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_window "
                "(restaurant_id, mode_code, rule_key, weekday, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {w['weekday']}, "
                f"{q(w['startsAt'])}, {q(w['endsAt'])});")
        for s in c["slots"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_slot "
                "(restaurant_id, mode_code, rule_key, weekday, slot_key, starts_at, ends_at) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {s['weekday']}, {q(s['slotKey'])}, "
                f"{q(s['startsAt'])}, {q(s['endsAt'])});")
        for cl in c["closures"]:
            sql_lines.append(
                "insert into public.restaurant_fulfillment_schedule_closure "
                "(restaurant_id, mode_code, rule_key, closed_on) values ("
                f"'{rid}', 'pickup', '{nil_rule}', {q(cl['closedOn'])});")
    # La sortie est canonicalisée pour être comparable au texte près :
    # statut | motif | première date | dates | offres.
    sql_lines.append(
        f"select '{cid}|' || coalesce(status,'-') || '|' || "
        "coalesce(unfulfillable_reason,'-') || '|' || "
        "coalesce(first_eligible_date::text,'-') || '|' || "
        "coalesce(array_to_string(eligible_dates, ','),'-') || '|' || "
        "coalesce((select string_agg(d || '=' || ("
        "  select string_agg(coalesce(o->>'slot_key','*') || '@' || (o->>'starts_at') "
        "    || '-' || (o->>'ends_at'), ';' order by (o->>'starts_at'), coalesce(o->>'slot_key','')) "
        "  from jsonb_array_elements(offers -> d) o), ' ' order by d) "
        " from jsonb_object_keys(coalesce(offers,'{}'::jsonb)) d), '-') "
        f"from public.resolve_fulfillment_schedule('{rid}', 'pickup', null, {q(c['nowIso'])}::timestamptz);")

    exp = c["expected"]
    dates = ",".join(d["date"] for d in exp["dates"]) or "-"
    offers = (
        " ".join(
            d["date"] + "=" + ";".join(
                (o["slotKey"] or "*") + "@" + o["startsAt"] + "-" + o["endsAt"]
                for o in sorted(d["offers"], key=lambda o: (o["startsAt"], o["slotKey"] or ""))
            )
            for d in exp["dates"]
        )
        or "-"
    )
    expected_lines.append(
        "|".join([
            cid,
            exp["status"],
            exp["reason"] or "-",
            exp["firstEligibleDate"] or "-",
            dates,
            offers,
        ])
    )

open(sql_path, "w", encoding="utf-8").write("\n".join(sql_lines) + "\n")
open(expected_path, "w", encoding="utf-8").write("\n".join(expected_lines) + "\n")
open(expected_path + ".refusals", "w", encoding="utf-8").write(
    ("\n".join(refusal_lines) + "\n") if refusal_lines else "")
print(f"{len(expected_lines)} cas rejoués + {len(refusal_lines)} cas refusés par contrainte")
