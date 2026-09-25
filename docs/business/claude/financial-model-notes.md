# Financial model — where it lives and how it works
 
Interactive model (sliders, scenario presets, four charts): https://claude.ai/code/artifact/5e5cd0e8-58b6-4955-b611-44fe29fdb0ac
 
Structure (monthly, 60 months): revenue = fixed-scope packages + day-rate consultancy + builder licences + consumer licences + token margin. Cost = founder pay + hires + employer on-costs + overhead + sales & marketing + partner commission + accreditation (year 1). Seats ramp from "new builder seats per month" growing by a yearly percentage, less churn; consumers follow builders at a ratio; the design partner's seats are discounted and shown separately. Consultancy tapers by half a year per year after the chosen year. Valuation shown two ways: services multiple on trailing-twelve-month revenue, and ARR multiple on the licence stream; per-founder = valuation × founders' equity ÷ founders.
 
Scenario presets: Full-salary plan (original), Sweat equity (recommended start), Consultancy-heavy, Product-heavy with partner channel, Council-led low price, Original £10 flat seat.
 
Headline results at the preset assumptions (25 Aug 2026):
- Full-salary plan: break-even month 39, cash trough about −£2.3m.
- Original £10 flat seat with full salaries: break-even month 49, trough about −£3.6m.
- Sweat equity: cash-positive from month 1 on 48 consulting days/month; ~24k seats and ~£3.2m licence ARR by year 5; per-founder value band £0.8–3.8m at year 5.
- Product-heavy via partners: ~62k seats, £8.7m ARR by year 5; per-founder £2–12m.
Placeholders to replace with research (see visualisation-plan.md, piece 8): services and ARR multiples, seat ramp rates by segment, token margin per seat. Assumptions can be exported/imported as JSON from the page.
 