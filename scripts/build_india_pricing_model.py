"""
Build the Lexy India pricing financial model (.xlsx).

Design:
- Yellow cells (#FFF2CC) = editable inputs. Everything else is a live formula.
- All formula sheets reference the Assumptions / Tiers sheets — no hardcoded
  numbers in formulas, so changing an input recomputes the whole model.
"""
import xlsxwriter

OUT = "exports/Lexy_India_Pricing_Model.xlsx"
wb = xlsxwriter.Workbook(OUT, {"nan_inf_to_errors": True})

# ── Formats ────────────────────────────────────────────────────────────────
title    = wb.add_format({"bold": True, "font_size": 18, "font_color": "#1F3864"})
subtitle = wb.add_format({"italic": True, "font_size": 11, "font_color": "#595959"})
section  = wb.add_format({"bold": True, "font_size": 11, "font_color": "white",
                          "bg_color": "#2F5496", "align": "left"})
label    = wb.add_format({"align": "left"})
label_b  = wb.add_format({"bold": True})
inp      = wb.add_format({"bg_color": "#FFF2CC", "border": 1, "num_format": "#,##0.00"})
inp_int  = wb.add_format({"bg_color": "#FFF2CC", "border": 1, "num_format": "#,##0"})
inp_pct  = wb.add_format({"bg_color": "#FFF2CC", "border": 1, "num_format": "0.0%"})
inp_inr  = wb.add_format({"bg_color": "#FFF2CC", "border": 1, "num_format": '"₹"#,##0'})
f_usd    = wb.add_format({"num_format": '"$"#,##0.000'})
f_inr    = wb.add_format({"num_format": '"₹"#,##0'})
f_inr2   = wb.add_format({"num_format": '"₹"#,##0.0'})
f_inr_b  = wb.add_format({"num_format": '"₹"#,##0', "bold": True})
f_int    = wb.add_format({"num_format": "#,##0"})
f_int1   = wb.add_format({"num_format": "#,##0.0"})
f_pct    = wb.add_format({"num_format": "0.0%"})
f_pct_b  = wb.add_format({"num_format": "0.0%", "bold": True})
hdr      = wb.add_format({"bold": True, "bg_color": "#2F5496", "font_color": "white",
                          "border": 1, "align": "center", "text_wrap": True, "valign": "vcenter"})
hdr_l    = wb.add_format({"bold": True, "bg_color": "#2F5496", "font_color": "white",
                          "border": 1, "align": "left", "valign": "vcenter"})
tot      = wb.add_format({"bold": True, "top": 6, "num_format": '"₹"#,##0'})
tot_pct  = wb.add_format({"bold": True, "top": 6, "num_format": "0.0%"})
wrap     = wb.add_format({"text_wrap": True, "valign": "top"})
bullet   = wb.add_format({"text_wrap": True, "valign": "top", "align": "left"})

# ── Computed values ─────────────────────────────────────────────────────────
# We mirror every formula in Python and embed the result as the formula's
# cached value. This way the workbook shows real numbers in ANY viewer
# (preview panes, Quick Look, email) — not just apps that recalculate.
FXv      = 95
INT_USD  = 0.30 + 0.08 + 0.17
SCR_USD  = 0.02 + 0.02 + 0.03 + 0.30
INT_INR  = INT_USD * FXv
SCR_INR  = SCR_USD * FXv
INFRA    = 800
PAYPCTv  = 0.02
UTIL_Iv  = 0.70
UTIL_Sv  = 0.60
CACv     = 40000
CHURNv   = 0.03

TIERS = [
    # name, monthly, seats, incl_int, incl_scr, overage, segment
    # Limits sized so every tier clears ~70%+ gross margin at default unit costs.
    ("Starter",    8999,   2,   15,   60,   299, "Startups / <50 employees"),
    ("Growth",     29999,  5,   60,   250,  249, "SMB / 50–200 employees"),
    ("Scale",      89999,  15,  200,  800,  199, "Mid-market / 200–1000"),
    ("Enterprise", 249999, 40,  600,  2500, 149, "Enterprise / custom"),
]

UE = []
for (_n, _mo, _s, _ii, _sc, _o, _seg) in TIERS:
    iu = _ii * UTIL_Iv
    su = _sc * UTIL_Sv
    ecogs = iu * INT_INR
    scogs = su * SCR_INR
    pay   = _mo * PAYPCTv
    total = ecogs + scogs + INFRA + pay
    gp    = _mo - total
    UE.append({"price": _mo, "iu": iu, "su": su, "ecogs": ecogs, "scogs": scogs,
               "pay": pay, "total": total, "gp": gp, "gm": gp / _mo})
AVG_J   = sum(x["gp"] for x in UE) / len(UE)
LTV     = AVG_J / CHURNv
LTV_CAC = LTV / CACv

STARTS = [(5, 2), (2, 1), (1, 0.5), (0, 0.2)]
CUST = [[0.0] * 24 for _ in range(4)]
for ti, (st, ad) in enumerate(STARTS):
    for m in range(24):
        CUST[ti][m] = st if m == 0 else CUST[ti][m - 1] * (1 - CHURNv) + ad
PRICES = [t[1] for t in TIERS]
PROJ = []
for m in range(24):
    cs   = [CUST[ti][m] for ti in range(4)]
    mrr  = sum(cs[ti] * PRICES[ti] for ti in range(4))
    cogs = sum(cs[ti] * UE[ti]["total"] for ti in range(4))
    gp   = mrr - cogs
    PROJ.append({"totc": sum(cs), "mrr": mrr, "cogs": cogs,
                 "gp": gp, "gm": gp / mrr if mrr else 0, "arr": mrr * 12})

G_PRICE = TIERS[1][1]
G_SCRU  = TIERS[1][4] * UTIL_Sv
def sens_val(iv, fx):
    cogs = iv * INT_USD * fx + G_SCRU * SCR_USD * fx + INFRA + G_PRICE * PAYPCTv
    return (G_PRICE - cogs) / G_PRICE

# ════════════════════════════════════════════════════════════════════════════
# 1. STRATEGY SHEET
# ════════════════════════════════════════════════════════════════════════════
s = wb.add_worksheet("Strategy")
s.hide_gridlines(2)
s.set_column("A:A", 2)
s.set_column("B:B", 110)
r = 1
s.write(r, 1, "Lexy — India Pricing Model", title); r += 1
s.write(r, 1, "Strategy, packaging recommendation, and a live financial model you can tweak.", subtitle); r += 2

def block(heading, lines):
    global r
    s.write(r, 1, heading, section); r += 1
    for ln in lines:
        s.write(r, 1, ln, bullet)
        s.set_row(r, 15 * (1 + ln.count("\n") + len(ln) // 95))
        r += 1
    r += 1

block("THE CORE PROBLEM", [
    "Lexy is AI-heavy: every interview burns real money (Azure speech-to-text + text-to-speech + GPT-4o on every "
    "turn, plus a final report). Sourcing, screening, verification and outreach each add GPT-4o + data-API costs "
    "per candidate. So unlike a classic ATS, Lexy has a real, usage-linked cost of goods (COGS).",
    "India is price-sensitive on the SUBSCRIPTION line but accepts usage/credit-based AI billing. The winning model "
    "is therefore a HYBRID: a modest platform subscription (covers seats + product), plus included AI usage with "
    "transparent overage. This protects gross margin when a customer runs lots of interviews.",
])

block("RECOMMENDED MODEL — Hybrid: Subscription + AI Usage Credits", [
    "1. Platform subscription (monthly/annual) priced in INR by company size — gives seats, ATS/pipeline, agents.",
    "2. Each tier INCLUDES a monthly pool of AI interviews + candidate screens (the expensive units).",
    "3. Overage is billed per extra AI interview (transparent ₹/interview) so heavy users stay margin-positive.",
    "4. Annual plans get ~2 months free (≈17% discount) to pull cash forward and reduce churn.",
    "5. Enterprise is custom (SSO, data residency in India, dedicated support, volume interview pricing).",
])

block("WHY THIS WINS IN INDIA", [
    "• Low entry price (Starter) clears the price-sensitivity hurdle and drives logo volume / land-and-expand.",
    "• Included AI credits make the value tangible (\"50 AI interviews/month\") without scaring buyers with metering.",
    "• Overage + tier limits keep gross margin healthy even if a customer's hiring spikes.",
    "• Usage-linked design means your Azure/OpenAI costs are always covered by revenue — never an open-ended loss.",
])

block("HOW TO USE THIS WORKBOOK", [
    "• YELLOW cells are your inputs — change them and the whole model recomputes. Everything else is a formula.",
    "• 'Assumptions'  → FX rate, AI unit costs, COGS, usage behaviour, go-to-market.",
    "• 'Tiers'        → the actual price list (prices, included usage, overage).",
    "• 'Unit Economics' → per-tier gross margin (the single most important output — keep every tier >70%).",
    "• 'Projection'   → 24-month MRR / ARR / gross-profit ramp from your customer-growth inputs.",
    "• 'Sensitivity'  → how gross margin moves with the USD→INR rate and interviews-per-customer.",
    "",
    "NOTE: all unit-cost numbers are reasonable starting estimates — replace them with your real Azure/OpenAI "
    "invoices as you get them. The structure is what matters; the inputs are yours to own.",
])

# ════════════════════════════════════════════════════════════════════════════
# 2. ASSUMPTIONS SHEET   (column B holds values; rows are referenced elsewhere)
# ════════════════════════════════════════════════════════════════════════════
a = wb.add_worksheet("Assumptions")
a.hide_gridlines(2)
a.set_column("A:A", 46)
a.set_column("B:B", 16)
a.set_column("C:C", 40)
a.freeze_panes(2, 0)
a.write(0, 0, "Model Assumptions", title)
a.write(1, 0, "Edit the yellow cells. INR figures derive from USD via the FX rate.", subtitle)

# Helper to write a labelled input/formula row. Returns the Excel (1-based) row.
def arow(row0, lbl, val=None, fmt=label, note=""):
    a.write(row0, 0, lbl, fmt)
    if val is not None:
        if isinstance(val, str) and val.startswith("="):
            a.write_formula(row0, 1, val)
        else:
            a.write(row0, 1, val, fmt if fmt in (inp, inp_int, inp_pct, inp_inr) else None)
    if note:
        a.write(row0, 2, note, subtitle)
    return row0 + 1  # 1-based Excel row == row0+1

# We control layout explicitly so cross-sheet references are stable.
a.write(3, 0, "GLOBAL", section); a.write(3,1,"",section); a.write(3,2,"",section)
a.write(4, 0, "USD → INR exchange rate")
a.write(4, 1, 95, inp); a.write(4, 2, "Update to live rate", subtitle)
FX = "Assumptions!$B$5"

a.write(6, 0, "AI UNIT COSTS  (per unit, USD)", section); a.write(6,1,"",section); a.write(6,2,"",section)
a.write(7, 0, "Azure STT per interview");           a.write(7,1,0.30, inp)
a.write(8, 0, "Azure TTS per interview");           a.write(8,1,0.08, inp)
a.write(9, 0, "GPT-4o per interview (+ final report)"); a.write(9,1,0.17, inp)
a.write(10,0, "Cost per AI interview (USD)", label_b); a.write_formula(10,1,"=SUM(B8:B10)", f_usd, INT_USD)
a.write(11,0, "Cost per AI interview (INR)", label_b); a.write_formula(11,1,f"=B11*{FX}", f_inr2, INT_INR)
COST_INTERVIEW_INR = "Assumptions!$B$12"

a.write(13,0, "Resume screen (GPT-4o)");   a.write(13,1,0.02, inp)
a.write(14,0, "Verification (GPT-4o)");    a.write(14,1,0.02, inp)
a.write(15,0, "Outreach draft (GPT-4o)");  a.write(15,1,0.03, inp)
a.write(16,0, "Sourcing enrichment / candidate"); a.write(16,1,0.30, inp)
a.write(17,0, "Cost per screened candidate (USD)", label_b); a.write_formula(17,1,"=SUM(B14:B17)", f_usd, SCR_USD)
a.write(18,0, "Cost per screened candidate (INR)", label_b); a.write_formula(18,1,f"=B18*{FX}", f_inr2, SCR_INR)
COST_SCREEN_INR = "Assumptions!$B$19"

a.write(20,0, "OTHER COGS  (INR / customer / month)", section); a.write(20,1,"",section); a.write(20,2,"",section)
a.write(21,0, "Infra & hosting per customer / month"); a.write(21,1,800, inp_inr)
a.write(22,0, "Payment processing (% of revenue)");    a.write(22,1,0.02, inp_pct)
INFRA_INR = "Assumptions!$B$22"
PAYPCT    = "Assumptions!$B$23"

a.write(24,0, "USAGE BEHAVIOUR", section); a.write(24,1,"",section); a.write(24,2,"",section)
a.write(25,0, "Avg utilisation of included interviews"); a.write(25,1,0.70, inp_pct)
a.write(26,0, "Avg utilisation of included screens");    a.write(26,1,0.60, inp_pct)
UTIL_INT = "Assumptions!$B$26"
UTIL_SCR = "Assumptions!$B$27"

a.write(28,0, "GO-TO-MARKET", section); a.write(28,1,"",section); a.write(28,2,"",section)
a.write(29,0, "Blended CAC per customer (INR)"); a.write(29,1,40000, inp_inr)
a.write(30,0, "Monthly logo churn");             a.write(30,1,0.03, inp_pct)
CHURN = "Assumptions!$B$31"
CAC   = "Assumptions!$B$30"

# ════════════════════════════════════════════════════════════════════════════
# 3. TIERS SHEET   (the price list)
# ════════════════════════════════════════════════════════════════════════════
t = wb.add_worksheet("Tiers")
t.hide_gridlines(2)
t.write(0, 0, "Pricing Tiers (INR)", title)
t.write(1, 0, "Yellow = editable. Annual price = 10× monthly (≈2 months free).", subtitle)
cols = ["Tier", "Monthly Price", "Annual Price", "Seats",
        "Incl. AI Interviews / mo", "Incl. Screens / mo", "Overage / interview", "Target segment"]
widths = [14, 14, 14, 8, 14, 13, 13, 26]
for i, (c, w) in enumerate(zip(cols, widths)):
    t.write(3, i, c, hdr); t.set_column(i, i, w)
t.freeze_panes(4, 0)

# tier rows (Excel rows 5-8 => index 4-7); price list defined once in TIERS above
tiers = TIERS
for i, (name, mo, seats, ii, sc, ov, seg) in enumerate(tiers):
    rr = 4 + i
    t.write(rr, 0, name, label_b)
    t.write(rr, 1, mo, inp_inr)
    t.write_formula(rr, 2, f"=B{rr+1}*10", f_inr, mo * 10)
    t.write(rr, 3, seats, inp_int)
    t.write(rr, 4, ii, inp_int)
    t.write(rr, 5, sc, inp_int)
    t.write(rr, 6, ov, inp_inr)
    t.write(rr, 7, seg, label)
# Tiers price cells: B5..B8 ; incl interviews E5..E8 ; screens F5..F8

# ════════════════════════════════════════════════════════════════════════════
# 4. UNIT ECONOMICS SHEET
# ════════════════════════════════════════════════════════════════════════════
u = wb.add_worksheet("Unit Economics")
u.hide_gridlines(2)
u.write(0, 0, "Per-Customer Unit Economics (monthly, INR)", title)
u.write(1, 0, "Gross margin by tier. Target: keep every tier above 70%.", subtitle)
ucols = ["Tier", "Monthly Price", "Interviews used", "Screens used",
         "Interview COGS", "Screen COGS", "Infra", "Payment proc.",
         "Total COGS", "Gross Profit", "Gross Margin %"]
uwidths = [14, 13, 12, 11, 13, 12, 10, 12, 12, 13, 13]
for i, (c, w) in enumerate(zip(ucols, uwidths)):
    u.write(3, i, c, hdr); u.set_column(i, i, w)
u.freeze_panes(4, 0)

for i in range(4):
    rr = 4 + i           # Unit Econ row index
    tr = 5 + i           # Tiers Excel row (1-based)
    er = rr + 1          # this sheet Excel row (1-based)
    u.write(rr, 0, tiers[i][0], label_b)
    u.write_formula(rr, 1, f"=Tiers!B{tr}", f_inr, UE[i]["price"])
    u.write_formula(rr, 2, f"=Tiers!E{tr}*{UTIL_INT}", f_int1, UE[i]["iu"])
    u.write_formula(rr, 3, f"=Tiers!F{tr}*{UTIL_SCR}", f_int1, UE[i]["su"])
    u.write_formula(rr, 4, f"=C{er}*{COST_INTERVIEW_INR}", f_inr, UE[i]["ecogs"])
    u.write_formula(rr, 5, f"=D{er}*{COST_SCREEN_INR}", f_inr, UE[i]["scogs"])
    u.write_formula(rr, 6, f"={INFRA_INR}", f_inr, INFRA)
    u.write_formula(rr, 7, f"=B{er}*{PAYPCT}", f_inr, UE[i]["pay"])
    u.write_formula(rr, 8, f"=SUM(E{er}:H{er})", f_inr, UE[i]["total"])
    u.write_formula(rr, 9, f"=B{er}-I{er}", f_inr, UE[i]["gp"])
    u.write_formula(rr, 10, f"=IFERROR(J{er}/B{er},0)", f_pct, UE[i]["gm"])
# LTV note row
u.write(9, 0, "LTV (gross profit ÷ churn):", label_b)
u.write_formula(9, 1, f"=AVERAGE(J5:J8)/{CHURN}", f_inr_b, LTV)
u.write(9, 3, "LTV : CAC ratio", label_b)
u.write_formula(9, 4, f"=IFERROR((AVERAGE(J5:J8)/{CHURN})/{CAC},0)", f_pct_b, LTV_CAC)
u.write(10, 0, "Blended CAC (Assumptions):", label)
u.write_formula(10, 1, f"={CAC}", f_inr, CACv)

# Gross-margin bar chart
chart_gm = wb.add_chart({"type": "column"})
chart_gm.add_series({
    "name": "Gross Margin %",
    "categories": "='Unit Economics'!$A$5:$A$8",
    "values":     "='Unit Economics'!$K$5:$K$8",
    "data_labels": {"value": True, "num_format": "0%"},
    "fill": {"color": "#2F5496"},
})
chart_gm.set_title({"name": "Gross Margin by Tier"})
chart_gm.set_y_axis({"num_format": "0%", "max": 1})
chart_gm.set_legend({"none": True})
u.insert_chart("A13", chart_gm, {"x_scale": 1.3, "y_scale": 1.1})

# ════════════════════════════════════════════════════════════════════════════
# 5. PROJECTION SHEET  (24 months)
# ════════════════════════════════════════════════════════════════════════════
p = wb.add_worksheet("Projection")
p.hide_gridlines(2)
p.write(0, 0, "24-Month Revenue Projection", title)
p.write(1, 0, "Set starting customers + monthly net adds per tier (yellow). Churn from Assumptions.", subtitle)

# Input block
p.write(3, 0, "Tier", hdr); p.write(3, 1, "Start Customers", hdr); p.write(3, 2, "Monthly Net Adds", hdr)
starts = [(5, 2), (2, 1), (1, 0.5), (0, 0.2)]
for i, (st, ad) in enumerate(starts):
    rr = 4 + i
    p.write(rr, 0, tiers[i][0], label_b)
    p.write(rr, 1, st, inp_int)
    p.write(rr, 2, ad, inp)
# start cells B5..B8 ; adds C5..C8  (Excel 1-based)

# Projection table
top = 10  # 0-indexed header row -> Excel row 11
pcols = ["Month", "Starter", "Growth", "Scale", "Enterprise", "Total Cust.",
         "MRR", "COGS", "Gross Profit", "GM %", "ARR"]
pwidths = [7, 9, 9, 9, 10, 11, 14, 14, 14, 8, 16]
for i, (c, w) in enumerate(zip(pcols, pwidths)):
    p.write(top, i, c, hdr); p.set_column(i, i, w)
p.freeze_panes(top + 1, 0)

for m in range(24):
    rr = top + 1 + m       # 0-indexed
    er = rr + 1            # Excel 1-based
    prev = er - 1
    p.write(rr, 0, m + 1, f_int)
    # explicit per-tier customer formulas (start, then churn + net adds)
    if m == 0:
        p.write_formula(rr, 1, "=B5", f_int1, CUST[0][m])   # Starter start
        p.write_formula(rr, 2, "=B6", f_int1, CUST[1][m])   # Growth
        p.write_formula(rr, 3, "=B7", f_int1, CUST[2][m])   # Scale
        p.write_formula(rr, 4, "=B8", f_int1, CUST[3][m])   # Enterprise
    else:
        p.write_formula(rr, 1, f"=B{prev}*(1-{CHURN})+C5", f_int1, CUST[0][m])
        p.write_formula(rr, 2, f"=C{prev}*(1-{CHURN})+C6", f_int1, CUST[1][m])
        p.write_formula(rr, 3, f"=D{prev}*(1-{CHURN})+C7", f_int1, CUST[2][m])
        p.write_formula(rr, 4, f"=E{prev}*(1-{CHURN})+C8", f_int1, CUST[3][m])
    p.write_formula(rr, 5, f"=SUM(B{er}:E{er})", f_int1, PROJ[m]["totc"])
    # MRR = sum(cust_tier * price_tier)
    p.write_formula(rr, 6,
        f"=B{er}*Tiers!$B$5+C{er}*Tiers!$B$6+D{er}*Tiers!$B$7+E{er}*Tiers!$B$8", f_inr, PROJ[m]["mrr"])
    # COGS = sum(cust_tier * per-customer total COGS from Unit Economics I5..I8)
    p.write_formula(rr, 7,
        f"=B{er}*'Unit Economics'!$I$5+C{er}*'Unit Economics'!$I$6"
        f"+D{er}*'Unit Economics'!$I$7+E{er}*'Unit Economics'!$I$8", f_inr, PROJ[m]["cogs"])
    p.write_formula(rr, 8, f"=G{er}-H{er}", f_inr, PROJ[m]["gp"])
    p.write_formula(rr, 9, f"=IFERROR(I{er}/G{er},0)", f_pct, PROJ[m]["gm"])
    p.write_formula(rr, 10, f"=G{er}*12", f_inr, PROJ[m]["arr"])

last = top + 24  # 0-indexed last data row
# MRR/Gross profit line chart
chart_mrr = wb.add_chart({"type": "line"})
chart_mrr.add_series({
    "name": "MRR",
    "categories": f"=Projection!$A${top+2}:$A${last+1}",
    "values":     f"=Projection!$G${top+2}:$G${last+1}",
    "line": {"color": "#2F5496", "width": 2.25},
})
chart_mrr.add_series({
    "name": "Gross Profit",
    "categories": f"=Projection!$A${top+2}:$A${last+1}",
    "values":     f"=Projection!$I${top+2}:$I${last+1}",
    "line": {"color": "#70AD47", "width": 2.25},
})
chart_mrr.set_title({"name": "MRR & Gross Profit (24 months)"})
chart_mrr.set_x_axis({"name": "Month"})
chart_mrr.set_y_axis({"name": "INR", "num_format": '₹#,##0'})
p.insert_chart("M3", chart_mrr, {"x_scale": 1.5, "y_scale": 1.5})

# ════════════════════════════════════════════════════════════════════════════
# 6. SENSITIVITY SHEET  (Gross margin vs FX rate × interviews per customer)
#    Computed for the Growth tier.
# ════════════════════════════════════════════════════════════════════════════
sv = wb.add_worksheet("Sensitivity")
sv.hide_gridlines(2)
sv.write(0, 0, "Sensitivity — Growth Tier Gross Margin %", title)
sv.write(1, 0, "Rows: AI interviews used / month. Cols: USD→INR rate. Cell = gross margin %.", subtitle)
sv.set_column("A:A", 24)

interviews = [30, 60, 90, 120, 180, 240]        # rows
fx_rates   = [88, 92, 95, 98, 102, 106]          # cols

corner = wb.add_format({"bold": True, "bg_color": "#1B3A5C", "font_color": "white",
                        "align": "center", "text_wrap": True, "border": 1})
axfmt  = wb.add_format({"bold": True, "bg_color": "#1B3A5C", "font_color": "white",
                        "align": "center", "border": 1, "num_format": "#,##0"})
cellp  = wb.add_format({"num_format": "0.0%", "align": "center", "border": 1})

sr = 3  # 0-indexed header row of grid
sv.write(sr, 0, "Interviews ↓  /  FX →", corner)
for j, fx in enumerate(fx_rates):
    sv.write(sr, j + 1, fx, axfmt)
    sv.set_column(j + 1, j + 1, 10)

# Growth tier price = Tiers!B6 ; screens used assumed from Growth incl * util.
price = "Tiers!$B$6"
scr_used = f"Tiers!$F$6*{UTIL_SCR}"
for i, iv in enumerate(interviews):
    rr = sr + 1 + i
    er = rr + 1
    sv.write(rr, 0, iv, axfmt)
    for j, fx in enumerate(fx_rates):
        col = chr(ord("B") + j)
        # COGS = interviews*interviewUSD*FX + screensUsed*screenUSD*FX + infra + price*paypct
        # interview USD cost = Assumptions B11 ; screen USD = Assumptions B18
        formula = (
            f"=IFERROR(({price}-("
            f"$A{er}*Assumptions!$B$11*{col}$4"
            f"+{scr_used}*Assumptions!$B$18*{col}$4"
            f"+{INFRA_INR}+{price}*{PAYPCT}))/{price},0)"
        )
        sv.write_formula(rr, j + 1, formula, cellp, sens_val(iv, fx))

sv.conditional_format(sr + 1, 1, sr + len(interviews), len(fx_rates), {
    "type": "3_color_scale",
    "min_color": "#F8696B", "mid_color": "#FFEB84", "max_color": "#63BE7B",
})
sv.write(sr + len(interviews) + 2, 0,
         "Green = healthy margin. Watch the bottom-right (weak rupee + heavy usage).", subtitle)

wb.close()
print("WROTE", OUT)
