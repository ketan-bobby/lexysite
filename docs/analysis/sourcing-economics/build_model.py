"""Build an assumption-led pricing model. No network, application imports or DB writes."""
import csv
import json
import math
from pathlib import Path

import xlsxwriter
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "lexy-tier-economics.xlsx"
catalog = list(csv.DictReader((ROOT / "monthly-country-catalog.csv").open()))
snapshot = list(csv.DictReader((ROOT / "usage-snapshot.csv").open()))
context = list(csv.DictReader((ROOT / "capture-context.csv").open()))[0]
us = {r["plan_code"]: float(r["amount"]) for r in catalog if r["country"] == "US"}
SCENARIOS = ["Low", "Base", "High"]
# All non-price inputs are explicit sensitivities, not measured costs or bounds.
INPUTS = [
    ("input_rate", "GPT-4o uncached input / million tokens", 2.5, 2.5, 2.5, "USD/M", "Audit reference, not verified account rate"),
    ("cached_rate", "GPT-4o cached input / million tokens", 1.25, 1.25, 1.25, "USD/M", "Audit reference, not verified account rate"),
    ("output_rate", "GPT-4o output / million tokens", 10, 10, 10, "USD/M", "Audit reference, not verified account rate"),
    ("cache_share", "Input tokens eligible for cached pricing", 0, 0, 0, "fraction", "ASSUMPTION; no discount assumed"),
    ("retry", "Billed token/reprocessing multiplier", 1, 1.15, 1.5, "factor", "ASSUMPTION; not a verified retry ceiling"),
    ("discovery", "Discovery + enrichment / usable profile", .10, .50, 1.25, "USD", "ASSUMPTION; includes discarded rows, duplicates, empty searches and consumed credits"),
    ("profile_in", "Aggregate profile-work input tokens", 5000, 15000, 35000, "tokens", "ASSUMPTION; parsing, screening, geo, matching, intelligence, reports; not just one call"),
    ("profile_out", "Aggregate profile-work output tokens", 1000, 3000, 6000, "tokens", "ASSUMPTION; aggregate before retry multiplier"),
    ("embedding", "Embedding / usable profile reserve", .001, .005, .02, "USD", "ASSUMPTION; actual embedding tokens/rate unavailable"),
    ("minutes", "Conversation minutes / interview", 20, 30, 45, "minutes", "ASSUMPTION; base anchored to 3 wall-clock intervals, NOT billed audio duration"),
    ("speech", "Combined STT + TTS reserve / conversation minute", .025, .075, .20, "USD/min", "ASSUMPTION; NOT a vendor tariff; includes both speech directions"),
    ("speech_retry", "Speech reprocessing multiplier", 1, 1.1, 1.35, "factor", "ASSUMPTION; not a hard bound"),
    ("conversation_in", "Total conversation input tokens / interview", 20000, 100000, 400000, "tokens", "ASSUMPTION; includes repeatedly sent context/history, not a per-turn constant"),
    ("conversation_out", "Total conversation output tokens / interview", 5000, 10000, 20000, "tokens", "ASSUMPTION"),
    ("assessment_in", "Final assessment input tokens / interview", 5000, 15000, 100000, "tokens", "ASSUMPTION"),
    ("assessment_out", "Final assessment output tokens / interview", 1000, 3000, 12000, "tokens", "ASSUMPTION"),
    ("task_in", "Additional standalone AI task input tokens", 1000, 2000, 5000, "tokens", "ASSUMPTION; excludes AI already costed in profiles/interviews"),
    ("task_out", "Additional standalone AI task output tokens", 250, 500, 1500, "tokens", "ASSUMPTION"),
    ("email", "Delivered email reserve", .001, .003, .01, "USD", "ASSUMPTION; not verified SES invoice"),
    ("video", "Intro-video generation reserve / unit", .50, 2, 5, "USD", "ASSUMPTION; quantities default to zero, not unlimited inclusion"),
    ("collection", "Collection / FX cost on revenue", 0, .01, .03, "fraction", "ASSUMPTION; manual collection, not Stripe activation"),
    ("starter_infra", "Starter hosting/database/storage allocation", 5, 12, 25, "USD/month", "ASSUMPTION; no infrastructure invoices supplied"),
    ("starter_support", "Starter direct support allocation", 8, 20, 45, "USD/month", "ASSUMPTION; loaded labor cost, not sales/R&D"),
    ("starter_unused", "Starter unused vendor commitment allocation", 2, 8, 20, "USD/month", "ASSUMPTION; unused share only, avoid double-counting consumed credits"),
    ("starter_other", "Starter other delivery reserve", 0, 2, 10, "USD/month", "ASSUMPTION; nonrecoverable vendor taxes/other activity; not a complete verified bill"),
    ("starter_learning", "Starter allocation to candidate learning/practice", 0, 5, 50, "USD/month", "ASSUMPTION; candidate product cost allocation is unknown, not free"),
    ("growth_infra", "Growth hosting/database/storage allocation", 10, 30, 60, "USD/month", "ASSUMPTION"),
    ("growth_support", "Growth direct support allocation", 15, 45, 100, "USD/month", "ASSUMPTION"),
    ("growth_unused", "Growth unused vendor commitment allocation", 5, 15, 40, "USD/month", "ASSUMPTION; unused share only"),
    ("growth_other", "Growth other delivery reserve", 0, 5, 20, "USD/month", "ASSUMPTION"),
    ("growth_learning", "Growth allocation to candidate learning/practice", 0, 15, 150, "USD/month", "ASSUMPTION; not a measured candidate cohort"),
    ("enterprise_infra", "Enterprise example infrastructure allocation", 60, 120, 250, "USD/month", "ASSUMPTION; example customer only"),
    ("enterprise_support", "Enterprise example direct support allocation", 150, 300, 600, "USD/month", "ASSUMPTION"),
    ("enterprise_unused", "Enterprise example unused commitments", 25, 75, 150, "USD/month", "ASSUMPTION"),
    ("enterprise_other", "Enterprise example other delivery reserve", 10, 25, 100, "USD/month", "ASSUMPTION"),
    ("enterprise_learning", "Enterprise candidate learning/practice allocation", 25, 80, 400, "USD/month", "ASSUMPTION; not a verified cost"),
]
VALUES = {s: {row[0]: row[2 + i] for row in INPUTS} for i, s in enumerate(SCENARIOS)}
CASES = [
    ["Starter proposed-use", "starter", us["starter"], 100, 20, 100, 100, 5],
    ["Growth proposed-use", "growth", us["growth"], 500, 100, 500, 500, 25],
    ["Starter independent-bucket stress", "starter", us["starter"], 100, 100, 1000, 500, 20],
    ["Growth independent-bucket stress", "growth", us["growth"], 500, 500, 5000, 2500, 100],
    ["Enterprise example workload", "enterprise", 0, 1000, 200, 2000, 10000, 50],
]

def text_cost(a, inputs, outputs):
    rate = a["input_rate"] * (1 - a["cache_share"]) + a["cached_rate"] * a["cache_share"]
    return (inputs * rate + outputs * a["output_rate"]) / 1_000_000 * a["retry"]

def units(a):
    profile_text = text_cost(a, a["profile_in"], a["profile_out"])
    speech = a["minutes"] * a["speech"] * a["speech_retry"]
    conversation = text_cost(a, a["conversation_in"], a["conversation_out"])
    assessment = text_cost(a, a["assessment_in"], a["assessment_out"])
    return {"discovery": a["discovery"], "profile_text": profile_text, "embedding": a["embedding"],
            "profile": a["discovery"] + profile_text + a["embedding"], "speech": speech,
            "conversation": conversation, "assessment": assessment,
            "interview": speech + conversation + assessment,
            "task": text_cost(a, a["task_in"], a["task_out"]), "email": a["email"], "video": a["video"]}

def fixed(a, tier):
    return sum(a[f"{tier}_{k}"] for k in ["infra", "support", "unused", "other", "learning"])

def evaluate(case, scenario):
    _, tier, price, profiles, interviews, tasks, emails, videos = case
    a, u = VALUES[scenario], units(VALUES[scenario])
    excluding_collection = (profiles * u["profile"] + interviews * u["interview"]
                            + tasks * u["task"] + emails * u["email"] + videos * u["video"] + fixed(a, tier))
    costs = excluding_collection + price * a["collection"]
    return {"cost": costs, "margin": (price - costs) / price if price else None,
            "quote_floor_75": excluding_collection / (1 - .75 - a["collection"])}

wb = xlsxwriter.Workbook(OUT)
wb.set_properties({"title": "Lexy tier economics — assumption-led, not invoice verified",
                   "comments": "Read-only evidence snapshot. No paid calls, billing edits or service restarts."})
wb.set_calc_mode("auto")
fmt = {
    "title": wb.add_format({"bold": True, "font_size": 18, "font_color": "#102C48"}),
    "header": wb.add_format({"bold": True, "bg_color": "#102C48", "font_color": "#FFFFFF", "text_wrap": True}),
    "text": wb.add_format({"text_wrap": True, "valign": "top"}),
    "warning": wb.add_format({"bg_color": "#FFF0CB", "text_wrap": True, "valign": "top"}),
    "input": wb.add_format({"font_color": "#1763B2", "bg_color": "#EDF5FF", "num_format": "0.####"}),
    "money": wb.add_format({"num_format": '$#,##0.00;[Red]($#,##0.00)'}),
    "unit": wb.add_format({"num_format": '$0.000000'}),
    "percent": wb.add_format({"num_format": '0.0%;[Red](0.0%)'}),
    "integer": wb.add_format({"num_format": "0"}),
}
sheets = {name: wb.add_worksheet(name) for name in [
    "Read me", "Summary", "Assumptions", "Unit costs", "Volumes", "Monthly model",
    "Allowance tradeoffs", "Enterprise quote", "Country check", "Evidence", "Customer draft",
]}
for sheet in sheets.values():
    sheet.freeze_panes(3, 1)
    sheet.set_column("A:A", 35)
    sheet.set_column("B:H", 19)
    sheet.set_default_row(23)

def heading(sheet, title, note, end=7):
    sheet.merge_range(0, 0, 0, end, title, fmt["title"])
    sheet.merge_range(1, 0, 1, end, note, fmt["warning"])
    sheet.set_row(1, 55)

readme = sheets["Read me"]
heading(readme, "Lexy economics: validate before selling allowances",
        "NOT A FORECAST OR VERIFIED COST QUOTE. Blue cells are editable. Formula caches show the initial sensitivity; Excel recalculates edits.")
notes = [
    ("Scope", f"Evidence captured {context['captured_at']} from the workspace/development database; not production, not invoices. Only aggregate activity and public country prices were exported."),
    ("Verified facts", "US catalog base prices: $299/$799, Enterprise custom. No sourcing ledger rows/account-rate rows were returned. Zero dispatched/settled sourcing operations. Activity credits are not vendor dollars."),
    ("Unknown actual costs", "No retained complete LLM token usage; no speech duration/billed-cost columns. No verified sourcing tariffs, hosting/support invoices, or unused commitments. Never substitute missing evidence with $0."),
    ("What low/base/high mean", "User-editable hypothetical sensitivities, not measured averages, confidence intervals or worst-case bounds. Text token prices are references from the dated audit, not verified account invoices."),
    ("Gross-margin convention", "Delivery margin = (subscription revenue minus modeled direct delivery costs) / revenue. Includes direct support; excludes sales, R&D, general administration and income tax. It is NOT net profit."),
    ("Revenue", "Subscription only, net of collected sales taxes. Seat/per-hire fees excluded from the base case. Existing fee terms and catalog prices are unchanged. Negotiated discounts/refunds need separate revenue inputs."),
    ("LLM coverage", "Profile token assumptions aggregate parsing, screening, geo, matching/intelligence and reports. Interview tokens include repeated conversation context and final assessment. Retries, embeddings and speech have separate reserves."),
    ("Avoid double counting", "Standalone AI task inputs EXCLUDE AI already priced in profiles/interviews. Independent-bucket stress uses illustrative additional workloads; if the real AI credit quota overlaps embedded calls, reduce standalone quantity. No quota coupling is asserted."),
    ("Speech", "Combined STT/TTS rate is a hypothetical per-conversation-minute reserve, not a measured audio tariff. Three completed session wall-clock intervals averaged 30 minutes; wall time is not billed audio."),
    ("Vendor commitments", "Discovery unit cost includes consumed retrieval/enrichment work, duplicates and failures. Fixed unused-commitment allocation covers only the unused portion. Do not count the entire vendor subscription twice."),
    ("Also costed provisionally", "Illustrative cached recruiter intro-video render quantities and an unverified candidate learning/practice allocation are included. Actual cache keys, candidate practice volume and vendor bills remain unknown."),
    ("Outside this first model", "SMS, specialist checks and other paid add-ons need explicit additional volumes/reserves if offered. No zero quantity represents an unlimited/free entitlement."),
    ("Country economics", "Country sheet holds US scenario inputs constant only for sensitivity. Non-USD FX cells are blank until supplied. Regional support cost may differ. One worldwide allowance is not certified."),
    ("Full utilization", "Stress uses existing 100/500 interview counts and 1,000/5,000 additional task scenarios; it is NOT proof every AI credit has that cost or these quotas are enforced/coupled. Existing contracts are not reduced."),
    ("Decision gate", "Do not publish 100/500 source profiles, promise unlimited third-party work or enable a new paid dispatcher based on this workbook. Capture actual usage and reconcile vendor/hosting invoices first."),
]
for r, (label, text) in enumerate(notes, 3):
    readme.write(r, 0, label, fmt["header"])
    readme.merge_range(r, 1, r, 7, text, fmt["text"])
    readme.set_row(r, 60)

assumptions = sheets["Assumptions"]
heading(assumptions, "Editable assumptions — all costs remain unvalidated",
        "Public text-token references are dated audit evidence. All other numbers are sensitivities, NOT current tariffs, billed usage or guaranteed ceilings.")
assumptions.write_row(3, 0, ["Input", *SCENARIOS, "Unit", "Evidence/status"], fmt["header"])
assumptions.set_column("A:A", 57)
assumptions.set_column("F:F", 83)
assumptions.set_row(3, 35)
positions = {}
for idx, row in enumerate(INPUTS, 4):
    key, label, *rest = row
    positions[key] = idx + 1
    assumptions.write(idx, 0, label, fmt["text"])
    for j, value in enumerate(rest[:3], 1):
        assumptions.write(idx, j, value, fmt["input"])
        assumptions.data_validation(idx, j, idx, j, {"validate": "decimal", "criteria": ">=", "value": 0})
        if key in ["cache_share", "collection"]:
            assumptions.data_validation(idx, j, idx, j, {"validate": "decimal", "criteria": "between", "minimum": 0, "maximum": .20 if key == "collection" else 1})
    assumptions.write(idx, 4, rest[3], fmt["text"])
    assumptions.write(idx, 5, rest[4], fmt["text"])
    assumptions.set_row(idx, 42)

def ar(key, col):
    return f"Assumptions!{col}{positions[key]}"

def token_formula(in_key, out_key, col):
    return f"({ar(in_key,col)}*({ar('input_rate',col)}*(1-{ar('cache_share',col)})+{ar('cached_rate',col)}*{ar('cache_share',col)})+{ar(out_key,col)}*{ar('output_rate',col)})/1000000*{ar('retry',col)}"

unit_sheet = sheets["Unit costs"]
heading(unit_sheet, "Derived unit costs — USD, assumption-led",
        "These are scenario calculations, not verified cost per delivered candidate/interview. They do not fabricate vendor receipts.")
unit_sheet.write_row(3, 0, ["Activity", *SCENARIOS], fmt["header"])
unit_rows = {"discovery": 5, "profile_text": 6, "embedding": 7, "profile": 8,
             "speech": 10, "conversation": 11, "assessment": 12, "interview": 13,
             "task": 15, "email": 16, "video": 17}
for key, excel_row in unit_rows.items():
    unit_sheet.write(excel_row - 1, 0, key.replace("_", " ").title(), fmt["text"])
    for i, scenario in enumerate(SCENARIOS):
        col = chr(66 + i)
        expressions = {
            "discovery": ar("discovery", col), "profile_text": token_formula("profile_in", "profile_out", col),
            "embedding": ar("embedding", col), "profile": f"SUM({col}5:{col}7)",
            "speech": f"{ar('minutes',col)}*{ar('speech',col)}*{ar('speech_retry',col)}",
            "conversation": token_formula("conversation_in", "conversation_out", col),
            "assessment": token_formula("assessment_in", "assessment_out", col),
            "interview": f"SUM({col}10:{col}12)", "task": token_formula("task_in", "task_out", col),
            "email": ar("email", col), "video": ar("video", col),
        }
        unit_sheet.write_formula(excel_row - 1, i + 1, "=" + expressions[key], fmt["unit"], units(VALUES[scenario])[key])

volume_sheet = sheets["Volumes"]
heading(volume_sheet, "Editable monthly workloads — not activated allowances",
        "Proposed-use assumes 20% of the suggested profiles receive an interview. Stress tests independent activity buckets; actual credit overlap is unknown.")
volume_sheet.set_column("A:A", 46)
volume_sheet.write_row(3, 0, ["Workload", "Tier", "Revenue USD", "Fresh profiles", "Interviews", "Standalone AI tasks", "Emails", "Videos"], fmt["header"])
volume_sheet.set_row(3, 40)
case_rows = {}
for r, case in enumerate(CASES, 4):
    case_rows[case[0]] = r + 1
    volume_sheet.write_row(r, 0, case[:2], fmt["text"])
    for c, value in enumerate(case[2:], 2):
        volume_sheet.write(r, c, value, fmt["input"])
        volume_sheet.data_validation(r, c, r, c, {"validate": "decimal" if c == 2 else "integer", "criteria": ">=", "value": 0})

monthly = sheets["Monthly model"]
heading(monthly, "Monthly delivery economics — NOT verified profitability",
        "Compare low/base/high at proposed and stress workloads. Enterprise price is not set; its quote floor is in the separate sheet.", 12)
headers = ["Workload", "Scenario", "Revenue", "Profiles", "Interviews", "Other AI", "Email", "Video",
           "Fixed/reserves", "Collection/FX", "Total costs", "Delivery margin", "75% price floor"]
monthly.write_row(3, 0, headers, fmt["header"])
monthly.set_column("A:A", 46)
monthly.set_row(3, 40)
model_rows = {}
results = []
for case in CASES:
    name, tier, price, nprofile, ninterview, ntask, nemail, nvideo = case
    vrow = case_rows[name]
    for i, scenario in enumerate(SCENARIOS):
        row = 4 + len(results)
        er, col = row + 1, chr(66 + i)
        a, u = VALUES[scenario], units(VALUES[scenario])
        ev = evaluate(case, scenario)
        model_rows[(name, scenario)] = er
        monthly.write(row, 0, name)
        monthly.write(row, 1, scenario)
        monthly.write_formula(row, 2, f"=Volumes!C{vrow}", fmt["money"], price)
        costs = [nprofile * u["profile"], ninterview * u["interview"], ntask * u["task"],
                 nemail * u["email"], nvideo * u["video"], fixed(a, tier), price * a["collection"]]
        expressions = [f"Volumes!D{vrow}*'Unit costs'!{col}8", f"Volumes!E{vrow}*'Unit costs'!{col}13",
                       f"Volumes!F{vrow}*'Unit costs'!{col}15", f"Volumes!G{vrow}*'Unit costs'!{col}16",
                       f"Volumes!H{vrow}*'Unit costs'!{col}17",
                       "+".join(ar(f"{tier}_{k}", col) for k in ["infra", "support", "unused", "other", "learning"]),
                       f"C{er}*{ar('collection',col)}"]
        for c, (expr, value) in enumerate(zip(expressions, costs), 3):
            monthly.write_formula(row, c, "=" + expr, fmt["money"], value)
        monthly.write_formula(row, 10, f"=SUM(D{er}:J{er})", fmt["money"], ev["cost"])
        monthly.write_formula(row, 11, f'=IF(C{er}>0,(C{er}-K{er})/C{er},"UNQUOTED")',
                              fmt["percent"], ev["margin"] if price else "UNQUOTED")
        monthly.write_formula(row, 12, f'=IF(1-0.75-{ar("collection",col)}>0,SUM(D{er}:I{er})/(1-0.75-{ar("collection",col)}),"INVALID RATE")',
                              fmt["money"], ev["quote_floor_75"])
        results.append({"workload": name, "scenario": scenario, **ev})
monthly.conditional_format(4, 11, 18, 11, {"type": "cell", "criteria": "<", "value": .75,
                                        "format": wb.add_format({"bg_color": "#FFD8D2"})})

summary = sheets["Summary"]
heading(summary, "Pricing decision: current allowances are not cost-validated",
        "Actual unit costs are UNKNOWN. Read scenario results as sensitivities, never as measured margins or approved commercial commitments.")
summary.write_row(3, 0, ["Workload", "Low margin", "Base margin", "High margin", "Base monthly costs"], fmt["header"])
summary.set_column("A:A", 46)
for row, case in enumerate(CASES[:4], 4):
    name = case[0]
    summary.write(row, 0, name)
    for i, scenario in enumerate(SCENARIOS):
        summary.write_formula(row, i + 1, f"='Monthly model'!L{model_rows[(name, scenario)]}",
                              fmt["percent"], evaluate(case, scenario)["margin"])
    summary.write_formula(row, 4, f"='Monthly model'!K{model_rows[(name,'Base')]}", fmt["money"], evaluate(case, "Base")["cost"])
summary.write_row(10, 0, ["Margin target", "Starter total cost ceiling", "Growth total cost ceiling"], fmt["header"])
for r, target in enumerate([.70, .75, .80], 11):
    summary.write(r, 0, target, fmt["percent"])
    for c, price in enumerate([us["starter"], us["growth"]], 1):
        summary.write_formula(r, c, f"={price}*(1-A{r+1})", fmt["money"], price * (1 - target))
summary.merge_range(16, 0, 18, 7,
    "Decision: no launch allowance is certified. Lower-priced country catalogs need their own economics. Preserve existing prices/contracts. Next capture real token usage, billable speech duration, retries and invoice allocations before approving new volumes.", fmt["warning"])

trade = sheets["Allowance tradeoffs"]
heading(trade, "What could fit? Conditional combinations, not recommendations",
        "All low/base/high sensitivities; recurring costs, pilot standalone AI/email/video volumes and collection reserve retained. Core failure is not an allowance of zero.", 7)
trade.write_row(3, 0, ["Tier", "Margin target", "Interviews", "Core costs incl. interviews", "Profile headroom USD", "Max fresh profiles", "Status", "Cost scenario"], fmt["header"])
trade.set_column("G:G", 42)
trade.set_row(3, 45)
tradeoffs = []
for tier, interview_options, price, tasks, emails in [
    ("starter", [0, 5, 10, 20, 100], us["starter"], 100, 100),
    ("growth", [0, 10, 25, 100, 500], us["growth"], 500, 500),
]:
    for scenario in SCENARIOS:
        for target in [.70, .75, .80]:
            for count in interview_options:
                row = 4 + len(tradeoffs)
                er, col = row + 1, chr(66 + SCENARIOS.index(scenario))
                a, u = VALUES[scenario], units(VALUES[scenario])
                base_videos = 5 if tier == "starter" else 25
                core = (fixed(a, tier) + tasks * u["task"] + emails * u["email"]
                        + base_videos * u["video"] + price * a["collection"] + count * u["interview"])
                headroom = price * (1 - target) - core
                cap = math.floor(max(0, headroom) / u["profile"])
                trade.write_row(row, 0, [tier, target, count])
                trade.write(row, 1, target, fmt["percent"])
                trade.write(row, 7, scenario)
                core_expr = "+".join(ar(f"{tier}_{k}", col) for k in ["infra", "support", "unused", "other", "learning"])
                trade.write_formula(row, 3, f"={core_expr}+{tasks}*'Unit costs'!{col}15+{emails}*'Unit costs'!{col}16+{base_videos}*'Unit costs'!{col}17+{price}*{ar('collection',col)}+C{er}*'Unit costs'!{col}13", fmt["money"], core)
                trade.write_formula(row, 4, f"={price}*(1-B{er})-D{er}", fmt["money"], headroom)
                trade.write_formula(row, 5, f'=IF(\'Unit costs\'!{col}8>0,ROUNDDOWN(MAX(0,E{er})/\'Unit costs\'!{col}8,0),"UNKNOWN UNIT")', fmt["integer"], cap)
                status = "CORE EXCEEDS BUDGET" if headroom < 0 else "Conditional only — unvalidated costs"
                trade.write_formula(row, 6, f'=IF(E{er}<0,"CORE EXCEEDS BUDGET","Conditional only — unvalidated costs")', fmt["text"], status)
                tradeoffs.append({"tier": tier, "scenario": scenario, "target": target, "interviews": count, "headroom": headroom, "profiles": cap})

enterprise = sheets["Enterprise quote"]
heading(enterprise, "Enterprise: quote a workload, not unlimited spending",
        "Illustrative workload in Volumes, not a customer offer. Required revenue includes the scenario collection percentage without a circular formula.")
enterprise.write_row(3, 0, ["Margin target", *SCENARIOS], fmt["header"])
for row, target in enumerate([.70, .75, .80], 4):
    er = row + 1
    enterprise.write(row, 0, target, fmt["percent"])
    for i, scenario in enumerate(SCENARIOS):
        mr, col = model_rows[(CASES[4][0], scenario)], chr(66 + i)
        excl = evaluate(CASES[4], scenario)["cost"]
        enterprise.write_formula(row, i + 1, f'=IF(1-A{er}-{ar("collection",col)}>0,SUM(\'Monthly model\'!D{mr}:I{mr})/(1-A{er}-{ar("collection",col)}),"INVALID RATE")',
                                 fmt["money"], excl / (1 - target - VALUES[scenario]["collection"]))

country = sheets["Country check"]
heading(country, "Country check — prices are facts, costs/FX are not",
        "Target margin is editable in B3. USD FX=1; other FX blank. US base core inputs held constant as a sensitivity, with zero interviews/source/video; not local cost estimates.", 12)
country.write(2, 0, "Target margin")
country.write(2, 1, .75, fmt["input"])
country.data_validation("B3", {"validate": "decimal", "criteria": "between", "minimum": 0, "maximum": .95})
country.write_row(3, 0, ["Country", "Tier", "Currency", "Monthly price", "Seat fee", "Hire fee", "FX USD/unit", "Revenue USD", "Cost ceiling USD", "Base core USD", "Profile headroom", "Max profiles", "Status"], fmt["header"])
country.set_column("M:M", 42)
country.set_row(3, 50)
for row, record in enumerate(catalog, 4):
    er = row + 1
    tier, ccy, price = record["plan_code"], record["currency"], float(record["amount"])
    country.write_row(row, 0, [record["country"], tier, ccy, price, float(record["per_seat_amount"]), float(record["per_hire_amount"])])
    usd = ccy == "USD" and price >= 0 and tier in ["starter", "growth"]
    if ccy == "USD":
        country.write(row, 6, 1, fmt["input"])
    else:
        country.write_blank(row, 6, None, fmt["input"])
    country.data_validation(row, 6, row, 6, {"validate": "decimal", "criteria": ">", "value": 0})
    revenue = price if usd else ""
    country.write_formula(row, 7, f'=IF(OR(D{er}<0,G{er}=""),"",D{er}*G{er})', fmt["money"], revenue)
    country.write_formula(row, 8, f'=IF(H{er}="","",H{er}*(1-$B$3))', fmt["money"], revenue * .25 if usd else "")
    if tier in ["starter", "growth"]:
        tasks, emails = (100, 100) if tier == "starter" else (500, 500)
        a, u = VALUES["Base"], units(VALUES["Base"])
        videos = 5 if tier == "starter" else 25
        core = fixed(a, tier) + tasks * u["task"] + emails * u["email"] + videos * u["video"] + price * a["collection"] if usd else ""
        expr = "+".join(ar(f"{tier}_{k}", "C") for k in ["infra", "support", "unused", "other", "learning"])
        country.write_formula(row, 9, f'=IF(H{er}="","",{expr}+{tasks}*\'Unit costs\'!C15+{emails}*\'Unit costs\'!C16+{videos}*\'Unit costs\'!C17+H{er}*{ar("collection","C")})', fmt["money"], core)
        headroom = revenue * .25 - core if usd else ""
        country.write_formula(row, 10, f'=IF(H{er}="","",I{er}-J{er})', fmt["money"], headroom)
        country.write_formula(row, 11, f'=IF(H{er}="","",IF(\'Unit costs\'!C8>0,ROUNDDOWN(MAX(0,K{er})/\'Unit costs\'!C8,0),"UNKNOWN UNIT"))', fmt["integer"], math.floor(max(0, headroom) / u["profile"]) if usd else "")
        status = ("CORE EXCEEDS BUDGET" if headroom < 0 else "Conditional — no interviews included") if usd else "FX NEEDED"
        country.write_formula(row, 12, f'=IF(H{er}="","FX NEEDED",IF(K{er}<0,"CORE EXCEEDS BUDGET","Conditional — no interviews included"))', fmt["text"], status)
    else:
        country.write(row, 12, "CUSTOM CONTRACT — NO IMPLIED UNLIMITED SPEND", fmt["text"])
country.autofilter(3, 0, 3 + len(catalog), 12)

evidence = sheets["Evidence"]
heading(evidence, "Evidence inventory and observed activity",
        "Workspace/development aggregate snapshot, potentially including fixtures. Counts/timing are NOT customer utilization, billed usage, vendor spend or representative cohorts.")
evidence.set_column("A:A", 26)
evidence.set_column("B:B", 34)
evidence.write_row(3, 0, ["Category", "Dimension", "Classification", "Count", "Value", "Auxiliary"], fmt["header"])
for row, record in enumerate(snapshot, 4):
    evidence.write_row(row, 0, list(record.values()), fmt["text"])
extra = 6 + len(snapshot)
evidence.merge_range(extra, 0, extra + 2, 7,
    "No ledger/account-rate rows in the aggregate result. Explicit operation snapshot: zero dispatched and zero settled. This does NOT prove all platform/vendor costs are zero; this ledger does not reconcile every assisted tool or invoice.", fmt["warning"])
evidence.merge_range(extra + 4, 0, extra + 7, 7,
    "Source files: docs/engineering/sourcing-provider-cost-audit.md (2026-10-05); lib/db/src/schema/{sourcing-metering,credit-usage,interviews}.ts; retained STT schema discovered read-only; artifacts/api-server/src/lib/ai.ts returns response text without retained token usage at main helper paths. Plan capacities from existing lib/plans.ts; country prices from active monthly subscription_prices records.", fmt["text"])

customer = sheets["Customer draft"]
heading(customer, "Customer-facing tier draft — NOT FOR PUBLICATION",
        "US baseline references. Country/contract prices and existing seat/per-hire fees apply. New source/interview allowances are not approved; existing entitlements/contracts are unchanged.")
customer.write_row(3, 0, ["Included capability", "Starter", "Growth", "Enterprise"], fmt["header"])
customer.set_column("A:D", 32)
brief = [
    ["Monthly US base price", "$299", "$799", "Custom contract"],
    ["Included seats", "3", "10", "Contracted size"],
    ["Active work orders", "5", "25", "Contracted capacity"],
    ["Positioning", "Small hiring team", "Recruiting team / agency", "Scale, governance and service"],
    ["External sourcing", "Monthly quantity pending cost validation", "Larger monthly quantity pending cost validation", "Contracted monthly volume"],
    ["AI interviews", "Future package quantity under review; existing terms unchanged", "Future package quantity under review; existing terms unchanged", "Contracted volume and duration"],
    ["Core screening and reports", "Included, with explicit usage scope", "Included, with explicit usage scope", "Custom workflow scope"],
    ["Privacy / consent / fairness", "Included", "Included", "Included"],
    ["At the source limit", "Existing candidates remain accessible; new discovery pauses", "Existing candidates remain accessible; new discovery pauses", "Contracted exhaustion policy"],
    ["Extra spending", "No automatic top-ups or surprise charges", "No automatic top-ups or surprise charges", "Explicit approval required"],
]
for row, cells in enumerate(brief, 4):
    customer.write_row(row, 0, cells, fmt["text"])
    customer.set_row(row, 63)
wb.close()

# Verify cached results, formula presence, critical references and model invariants.
cached = load_workbook(OUT, data_only=True)
formulas = load_workbook(OUT, data_only=False)
assert math.isclose(cached["Unit costs"]["C8"].value, units(VALUES["Base"])["profile"], abs_tol=1e-9)
assert math.isclose(cached["Monthly model"]["K6"].value, evaluate(CASES[0], "Base")["cost"], abs_tol=1e-9)
assert math.isclose(cached["Monthly model"]["L6"].value, evaluate(CASES[0], "Base")["margin"], abs_tol=1e-9)
for row, record in enumerate(catalog, 5):
    if record["currency"] != "USD":
        assert cached["Country check"][f"G{row}"].value is None
        assert cached["Country check"][f"H{row}"].value in (None, "")
assert not cached._external_links
assert all(v["cost"] >= 0 and math.isfinite(v["cost"]) for v in results)
assert all(row["profiles"] >= 0 for row in tradeoffs)
for row in tradeoffs:
    if row["headroom"] >= 0:
        unit = units(VALUES[row["scenario"]])["profile"]
        assert row["profiles"] * unit <= row["headroom"] + 1e-9
        assert (row["profiles"] + 1) * unit > row["headroom"] - 1e-9
for sheet in formulas:
    for row in sheet:
        for cell in row:
            if cell.data_type == "f":
                assert "#REF!" not in cell.value and "[" not in cell.value
                result = cached[sheet.title][cell.coordinate]
                assert result.data_type != "e", (sheet.title, cell.coordinate, result.value)
formula_count = sum(c.data_type == "f" for sheet in formulas for row in sheet for c in row)
assert formula_count > 1500

output = {"captured_at": context["captured_at"], "evidence_scope": "workspace/development, not production or invoices",
          "validated_costs": False, "units": {s: units(VALUES[s]) for s in SCENARIOS},
          "cases": results, "tradeoffs": tradeoffs, "formula_count": formula_count,
          "catalog_rows": len(catalog), "unknown_fx": True}
(ROOT / "model-results.json").write_text(json.dumps(output, indent=2) + "\n")
lines = [
    "# Lexy tier economics — preliminary sensitivity model",
    "",
    "**Decision: do not commit to the proposed 100/500 profiles or new interview allowances yet.**",
    "This is an assumption-led cost model, not verified profitability. No paid searches/model calls, billing edits, app changes or service restarts were performed.",
    "",
    f"Evidence captured: {context['captured_at']} from workspace/development, not production or invoices.",
    "US active monthly catalog: Starter $299, Growth $799, Enterprise custom. Other countries differ; USD catalog prices include Starter $39 and Growth $99. Non-USD FX is deliberately unset.",
    "",
    "## Known versus unknown",
    "- No sourcing ledger/account-rate rows were returned; zero dispatched/settled sourcing operations. This does not mean overall vendor spend is zero.",
    "- Recorded activity: 2 interview credit units; 3 completed interviews with usable timing averaging 30 wall-clock minutes. These may include fixtures and are not representative production utilization.",
    "- 120 speech events (64 Whisper, 41 Sarvam, 15 none) do not retain billed audio minutes or USD costs.",
    "- The main AI text helper does not retain complete token usage. Missing data is UNKNOWN, not $0.",
    "- Discovery, speech, hosting, support, commitments and other reserves are editable hypothetical assumptions. GPT-4o token prices are dated public audit references, not verified private account rates.",
    "",
    "## Internal economics table",
    "Delivery margin includes modeled direct support/operations, before sales, R&D, general administration and income tax.",
    "",
    "| Workload | Low margin | Base margin | High margin | Base monthly delivery costs |",
    "|---|---:|---:|---:|---:|",
]
for case in CASES[:4]:
    ev = [evaluate(case, s) for s in SCENARIOS]
    lines.append(f"| {case[0]} | {ev[0]['margin']:.1%} | {ev[1]['margin']:.1%} | {ev[2]['margin']:.1%} | ${ev[1]['cost']:,.2f} |")
lines += [
    "",
    "Proposed-use workload: Starter 100 profiles/20 interviews/100 standalone AI tasks/100 emails/5 recruiter intro-video renders; Growth 500/100/500/500/25 renders. The 20% interview conversion is assumed. A separate candidate learning/practice allocation is a placeholder, not a measured cost.",
    "Independent-bucket stress uses 100/500 interviews, 1,000/5,000 ADDITIONAL standalone tasks and 500/2,500 emails. Actual AI credit overlap is unknown; reduce standalone quantities if they already include profile/interview tasks. This is not validated simultaneous entitlement enforcement.",
    "Stress also assumes 20/100 intro-video renders. These are hypothetical cache misses, not one render per interview. Candidate learning is allocated by an unverified fixed provision. SMS and specialist checks still need additional explicit budgets if included.",
    "",
    "## Conditional allowance tradeoffs at 75%",
    "These are arithmetic under BASE placeholder costs, not launch recommendations. Core delivery reserves and pilot AI/email usage remain included.",
    "",
    "| Tier | Interviews/month | Maximum profiles/month under assumptions | Status |",
    "|---|---:|---:|---|",
]
for row in tradeoffs:
    if row["target"] == .75 and row["scenario"] == "Base":
        lines.append(f"| {row['tier']} | {row['interviews']} | {row['profiles']} | {'Core alone exceeds budget' if row['headroom'] < 0 else 'Conditional, not verified'} |")
lines += [
    "",
    "## Customer-facing tier table — draft, not for publication",
    "| Capability | Starter | Growth | Enterprise |",
    "|---|---|---|---|",
]
for row in brief:
    lines.append("| " + " | ".join(row) + " |")
lines += [
    "",
    "## Next evidence required",
    "1. Retain actual input/cached/output tokens and model/version for every relevant AI attempt, including retries; avoid raw prompts and candidate PII.",
    "2. Capture speech duration/characters and provider billing units for STT/TTS, conversation and assessment; wall-clock session length is not sufficient.",
    "3. Obtain account/invoice costs and allocate consumed versus unused vendor commitments, infrastructure and direct support. Reconcile already recorded activity without launching a paid test.",
    "4. Recalculate by country and contract, test full utilization, then approve a bounded pilot separately. Do not silently alter existing prices, contracts or safeguards.",
    "",
    f"Workbook verified: {formula_count} cached, recalculating formulas; no external workbook links or macros. All calculated outputs remain unvalidated cost sensitivities.",
]
(ROOT / "economics-decision-brief.md").write_text("\n".join(lines) + "\n")
print(json.dumps({"workbook": str(OUT), "formula_count": formula_count,
                  "base_cases": [r for r in results if r["scenario"] == "Base"]}, indent=2))
