# Excelcion — visualisation and infographic plan
 
*Prepared 25 August 2026. A build plan for a set of interactive HTML pieces (D3, Vega-Lite or hand-rolled SVG) that let the founding team see the market, the operating model choices, the plausible trajectories and the money in one place. Each piece has its own research brief so the data-gathering can be parcelled out.*
 
## How the set fits together
 
The audience is five to ten senior engineers deciding whether to start a company, so the pieces should answer decisions, not decorate a deck. Each one is framed around a question the team will actually argue about. They are grouped into four chapters that mirror the conversation so far: the market (who buys, how many seats, what they pay today), the operating model (how consultancy, licence and channel fit together, and what the team looks like), trajectories (what companies like this actually did over 5–10 years, and what our own model does under different assumptions), and the path (accreditation, frameworks, sequencing). A final "one-page" piece condenses the whole argument.
 
Build them as a single static site: one repo, one shared stylesheet and colour system, one `data/` folder of JSON files each with a `sources` block, and one HTML file per piece so they can also be dropped into an artifact or a slide individually. Vega-Lite for anything that is a standard statistical chart (fast to build, easy for colleagues to tweak in JSON); D3 where layout is bespoke (sankeys, timelines, small multiples with annotations, the interactive model); plain HTML/CSS for the infographic-style pieces where the point is typography and arrangement, not marks. Everything should take a `data/*.json` input so that when a number changes the picture updates without touching code, and every figure on screen should be traceable to a source via a hover or footnote. Assume a light and a dark theme from the start.
 
Suggested order of build is given at the end; the short version is that the interactive financial model (piece 8) and the comparables trajectories (piece 6) are the two that change minds, so they go first.
 
---
 
## Chapter 1 — The market
 
### 1. Where the seats are: UK organisations by sector and size
 
**Question it answers.** How many potential seats exist in the target sectors, and what share of them is reachable by a ten-person company?
 
**Form.** A treemap or, better, a "seat map": a grid of rectangles sized by total employment in each sector, subdivided by organisation size band (50–249, 250–999, 1,000–4,999, 5,000+), with the target tiers from the routes-to-market report highlighted and the regulated sectors greyed. A toggle switches the sizing between headcount and estimated "builder" seats (the fraction of staff likely to build rather than only consume, which is the pricing distinction we care about). Hover shows number of organisations, employment, and the assumed builder fraction with its rationale.
 
**Data and research brief.** ONS Business Population Estimates 2025 (organisations and employment by SIC section and size band); ONS BRES for finer SIC detail on advertising (SIC 73), architecture and engineering (71), programming and broadcasting (59–60), publishing (58), management consultancy (70.2), employment activities (78), games (from UKIE/Nesta mapping); LGA and DfE workforce counts for councils and MATs; NHS and civil service headcounts for the "later" band. The research task is to reconcile SIC codes to our tiers and produce a single `sectors.json` with organisation counts and employment per size band, plus an explicit, argued builder-fraction assumption per sector (a range, not a point). Two to three days of desk research.
 
**Tech.** D3 (custom layout with annotations). Medium effort.
 
### 2. What they pay for AI today: the price ladder
 
**Question it answers.** Where does a £10 seat sit against what buyers already spend, and where is the money in the stack?
 
**Form.** A horizontal "price ladder" infographic with each product as a bar from its floor to its typical all-in cost per user per month: Copilot Chat (free with M365), M365 Copilot add-on (£13.80 promo / £16.10 list), M365 base plans, Copilot Studio credits translated to a per-builder equivalent, ChatGPT Enterprise/Team, Claude Team/Enterprise, Gemini for Workspace, Retool, Power Platform per-app and per-user, Palantir AIP (where public), Glean, plus Excelcion's proposed builder and consumer seats with a token band on top. A second panel decomposes a 1,000-person organisation's annual AI bill under three configurations (Microsoft-only, Excelcion + BYO key, Excelcion managed tokens) as stacked bars.
 
**Data and research brief.** Current UK list prices from vendor pages (dated, since several are changing in late 2026), typical token consumption per active builder and per consumer (derive from public usage studies and our own consultancy experience; document the assumption), Copilot Studio credit pricing and what a credit buys. Note the CMA probe and the expected Copilot bundling as annotations. One to two days; refresh quarterly.
 
**Tech.** Vega-Lite for the bars; HTML for the annotations. Low effort.
 
### 3. The buyer's mind: what CTOs say they are worried about
 
**Question it answers.** Is the "governed, cheaper AI" pitch aimed at a real anxiety, and does it vary by sector and size?
 
**Form.** Small multiples of diverging bar charts, one per survey, showing the ranked concerns (cost, data security, integration, skills, sovereignty, shadow AI, ROI) with our proposition's answer to each concern annotated. A dot-plot panel compares the same concerns across public sector (LGA), enterprise (Red Hat UK, Gartner/IDC where quotable) and SMEs (FSB or similar). A final "evidence strip" summarises the UK government Copilot trials (licences, usage per day, productivity finding) as a set of stat tiles, since it is the best public evidence that buyers are already sceptical.
 
**Data and research brief.** LGA AI survey, Red Hat UK survey, the DBT/HMRC/DWP Copilot evaluations, IAB UK State of AI in Advertising, any RIBA/ACE technology surveys for AEC, UKIE census for games, shadow-AI statistics with their original sources checked (many are recycled vendor numbers). Two days, with a strict rule that every figure links to a primary source.
 
**Tech.** Vega-Lite. Low effort.
 
### 4. The competitive map
 
**Question it answers.** Who else is standing where we want to stand, and where is the empty ground?
 
**Form.** A two-axis map: horizontal axis from "assistant you chat with" to "platform users build on"; vertical axis from "vendor cloud only" to "runs in your estate / on-prem / sovereign". Each competitor is a bubble sized by estimated UK presence or funding, coloured by origin (hyperscaler, enterprise SaaS, open-source vendor, SI). Excelcion sits top-right. A second lens toggles the vertical axis to "access-control depth" (none / per-user / per-document / capability-based with derivative tracking), which is the axis on which the architecture-of-distrust argument lives. Hovering shows the one-sentence pitch of each and what they charge.
 
**Data and research brief.** Compile Microsoft (Copilot, Copilot Studio, Power Platform), Google, OpenAI and Anthropic enterprise offerings, Retool, Appsmith, Budibase, ToolJet, Windmill, Grist, Directus, Nextcloud's AI assistant, Palantir AIP, Glean, Cloudflare OS (open source and forthcoming managed version) and its two named partners, plus UK SIs building agent platforms (Kainos, Made Tech, BJSS/CGI, Faculty). For each: deployment options, access-control model as documented, pricing, and UK public-sector or enterprise references. Three days; this is also the raw material for a competitor FAQ.
 
**Tech.** D3 (bubble map with two lens toggles). Medium effort.
 
---
 
## Chapter 2 — Operating models
 
### 5. How the money flows: operating-model sankeys
 
**Question it answers.** What does "hybrid consultancy plus licence plus channel" actually look like as cash, and how does the mix shift over time?
 
**Form.** Three side-by-side sankey diagrams for year 1, year 3 and year 5 under the base scenario: sources on the left (fixed-scope consultancy packages, day-rate consultancy, builder licences, consumer licences, token margin, partner commissions), flowing through "delivered by" (founders, associates, partners) to uses on the right (founder pay, associate costs, hosting, tooling, accreditation, sales and marketing, retained profit). A slider steps between years so the eye can follow consultancy shrinking and licences growing, the Percona-style transition. A companion mini-chart shows the equivalent mix for the comparables at their own year 1/3/5 where public.
 
**Data and research brief.** Comes from the financial model in piece 8; no external research beyond the comparables' revenue mixes already gathered (Percona 100% → 20% consulting; Fishtown's four consulting years; Snowplow's managed-service pivot). Half a day once the model exists.
 
**Tech.** D3 sankey. Medium effort.
 
### 6. Team shape and capacity
 
**Question it answers.** With five (then ten) people, how many billable days, how much product time, and how many customers can we actually serve, with and without associates and partners?
 
**Form.** A capacity infographic: a calendar-style grid of person-months for 24 months, each cell coloured by what that person-month is spent on (consultancy billable, product build, sales, accreditation, leave). Below it, a lever panel with the assumptions (billable utilisation target, product protection percentage, associate day rate and margin, partner-delivered share) and three outputs that update live: consultancy revenue, product capacity in engineer-months, and "customers we can onboard per quarter". A second view shows the same thing for three team configurations: five founders only; five plus a seller and fractional finance; the original ten-at-£200k plan.
 
**Data and research brief.** Internal assumptions only, plus a short benchmark check on utilisation rates for senior consultancies (Equal Experts, Thoughtworks and UK boutiques publish or leak 65–80%) and associate day-rate margins (typically 20–35%). Half a day.
 
**Tech.** Custom HTML/CSS grid with a little JS; no charting library needed. Low-to-medium effort.
 
### 7. Channel economics: direct vs partner vs marketplace
 
**Question it answers.** For a given customer, where does each pound go under each route to market, and which route gets us to 25,000 seats?
 
**Form.** A waterfall for a representative 500-seat deal under four routes: direct founder-led, via an implementation partner on Grist-style terms (partner keeps implementation fees, 25–30% licence discount, first-year commission), via a cloud marketplace private offer (3% fee, counted against customer commit), and via a G-Cloud reseller. Each waterfall runs from list value down to our net margin and shows the time-to-close as a bar beside it. A second panel is a simple funnel of how many deals each route can plausibly produce per year given team capacity from piece 6, so that "seats per year by route" is the punchline.
 
**Data and research brief.** Marketplace fee schedules (AWS, Azure, Google, already gathered), Odoo and Grist partner terms, typical SI referral fees, and sales-cycle lengths by segment (agency 1–3 months, enterprise 6–12, council 9–18) drawn from public procurement data and our own experience. One day.
 
**Tech.** Vega-Lite waterfalls with an HTML control panel. Low-to-medium effort.
 
---
 
## Chapter 3 — Trajectories
 
### 8. The interactive financial model (the centrepiece)
 
**Question it answers.** Under what assumptions does this company break even, pay the founders what they want, and reach a valuation that gives each founder the number they have in mind, and how sensitive is that to each lever?
 
**Form.** A single-page model with sliders on the left and four charts on the right. Sliders: founder salary in year 1 and year 2 (the biggest lever), number of hires and when, consultancy days sold per month and blended rate, package deals per quarter and price, builder seat price, consumer seat price, seat ramp (new seats per quarter by segment, with a design-partner discount), churn, token margin, partner-delivered share, accreditation and tooling spend. Charts: monthly revenue by stream vs cost (with the break-even month marked); cumulative cash and the trough (how much money the founders are actually risking); seats by segment over 60 months; and an implied valuation band using both a services multiple on revenue and an ARR multiple on the licence stream, with the per-founder outcome shown against the £2m/£10m/£50m targets. A "scenario" dropdown loads preset assumption sets (full-salary plan, sweat-equity plan, consultancy-heavy, product-heavy, council-led) so people can argue from the same starting points. Every run can be exported as JSON and pasted back.
 
**Data and research brief.** Internal assumptions, plus three externally researched inputs: current UK valuation multiples for IT services (typically 1–2x revenue or 8–12x EBITDA for sub-£20m firms; verify with 2025–26 UK deal data from sources such as Equiteq, Hampleton or MarktoMarket), ARR multiples for small vertical-SaaS and open-source companies (public SaaS indices and recent UK exits), and the SEIS/EIS and R&D tax credit effects on the cash trough. Two days of research, then the model logic itself is the bulk of the build.
 
**Tech.** D3 for charts, plain JS for the model; keep the model in a separate pure function so the same logic can drive a spreadsheet later. High effort; the one piece worth doing properly.
 
### 9. Comparables trajectories: what the horses actually did
 
**Question it answers.** How long did companies like this take to reach revenue, headcount and an outcome, and what did their revenue mix look like along the way?
 
**Form.** A connected-scatter or "race" chart: x-axis years since founding (0–15), y-axis revenue on a log scale, one line per company (Percona, Snowplow, Fishtown/dbt, Nextcloud, Directus, Bitnami, Basecamp, Redgate, Infinity Works, Contino, Made Tech, Element, Budibase, Grist), with line colour showing the dominant revenue type (services / support subscription / SaaS) and markers at funding rounds, pivots and exits. A second view swaps y for headcount, and a third for "revenue per head", which is where the calm companies separate from the scaled ones. Excelcion's base scenario from piece 8 is overlaid as a dashed line so the team can see which comparable they are actually describing.
 
**Data and research brief.** The hardest research in the set. For each company, year-by-year revenue and headcount from Companies House filings (UK ones: Snowplow, Made Tech, Infinity Works, Contino, Redgate, Element/New Vector, Budibase), interviews and podcasts (Percona's Sramana Mitra series, Fishtown's First Round piece), press releases and Crunchbase for rounds, and clearly flagged estimates where only bands exist. Produce `comparables.json` with a confidence field per data point. Four to five days; this doubles as the due-diligence pack for the comparables doc.
 
**Tech.** D3 (annotated multi-line with view toggles). Medium-to-high effort.
 
### 10. Exit and liquidity paths
 
**Question it answers.** What are the realistic ways the founders get money out, on what timescale, and what does each require of the company?
 
**Form.** A branching timeline (a horizontal tree): from "year 0" the paths fan out to profit distribution (calm company), secondary sale of a minority stake, trade sale to an SI, trade sale to a platform vendor, PE buy-out, employee-ownership trust with founder loan notes (the Equal Experts route, which is under-considered and tax-efficient in the UK), and IPO (shown for completeness and marked as improbable). Each branch is annotated with the typical year range, the metrics the buyer looks at, the valuation basis, worked per-founder outcomes from piece 8, and the pre-conditions (ARR share, revenue concentration limits, documented IP, clean cap table). A side panel explains what the shareholders' agreement needs to contain for each path (drag-along, tag-along, valuation-trigger clause, good/bad-leaver terms).
 
**Data and research brief.** UK exit data for IT services and small software (deal counts and multiples by year, 2021–26), EOT rules and Business Asset Disposal Relief, examples of SI acquisitions of 10–50 person product-led consultancies. Two days, ideally with a one-hour conversation with a corporate lawyer to check the clause descriptions.
 
**Tech.** Custom SVG/HTML tree with D3 for layout. Medium effort.
 
---
 
## Chapter 4 — The path
 
### 11. The accreditation ladder and framework calendar
 
**Question it answers.** What do we need, when, at what cost, and which doors does each certificate open?
 
**Form.** A Gantt-style timeline for months 0–30 with accreditations as bars (ICO, Cyber Essentials, CE Plus, insurance, pen test, ISO 27001 with stage 1/2 markers, ISO 42001, SOC 2 observation period, G-Cloud 15 reopening in ~March 2028, DOS7, Cyber Security and Resilience Bill commencement), each bar showing cost on hover and coloured by "who asks for it". Below it a matrix: rows are accreditations, columns are the target segments, cells show required / expected / nice-to-have, so the team can see that agencies and AEC need almost nothing while councils need the full ladder. A cumulative-cost line runs along the top.
 
**Data and research brief.** Already gathered in the routes-to-market report; the extra work is to confirm the ISO 42001 demand signal (search public tenders and RFPs from 2026 for it), the exact DOS7 supplier conditions, and to get two or three real quotes for CE Plus and ISO 27001 from UKAS bodies so the bars carry quotes rather than ranges. One day.
 
**Tech.** Vega-Lite Gantt plus an HTML matrix. Low effort.
 
### 12. The architecture-of-distrust explainer
 
**Question it answers.** What is it we are actually selling, in a picture a COO can follow in ninety seconds?
 
**Form.** A single animated diagram in three beats. Beat one: a user, an agent, and the company's systems (CRM, finance, files, HR) with the agent holding keys to everything, and a red path showing prompt injection or a careless tool call leaking client A's data into client B's output. Beat two: the Excelcion layer inserted, with capabilities instead of keys, per-user or per-document sandboxes, human approval of provisional actions, and every observation logged. Beat three: a derivative product (an app the user built) inheriting the same access model, so the thing a marketing exec vibe-coded on Friday can't see more than she could. A small side panel maps each beat to the buyer's questionnaire question it answers (sub-processors, data residency, audit, AI transparency under Article 50).
 
**Data and research brief.** Cloudflare OS documentation (Gatekeepers, per-document instancing, capability model), Jamie Lord's essay, and two or three real questionnaire questions from a CAIQ template. Half a day; mostly design work.
 
**Tech.** Hand-built SVG with CSS/JS animation. Medium effort but high value; also the first thing to reuse in sales material.
 
### 13. The one-page argument
 
**Question it answers.** Can the whole case be seen at once?
 
**Form.** A single scrolling infographic that stitches the key figure from each piece above into a narrative: the seat map (1), the price ladder (2), the buyer concerns (3), the empty ground on the competitive map (4), the year-5 sankey (5), the base-case revenue and cash trough (8), the comparable we most resemble (9), and the accreditation ladder (11), each as a static export with two sentences of text. This is the version that goes to a potential colleague who has twenty minutes.
 
**Data and research brief.** None; assembled from the others once they are stable.
 
**Tech.** HTML/CSS with embedded SVG exports from the other pieces. Low effort, done last.
 
---
 
## Shared foundations
 
**Design system.** One palette with a neutral base, one accent for Excelcion, a muted categorical set for competitors and comparables, and a sequential ramp for money; light and dark variants defined as CSS variables. Typography and spacing shared across all pieces so that screenshots from different charts sit together in a deck. Every chart carries a title framed as its question, a one-sentence takeaway under it, and a sources footnote.
 
**Data discipline.** Each `data/*.json` file has a `meta` block: date gathered, who gathered it, source URLs, and a confidence grade (A: primary source with a figure; B: reputable secondary; C: our estimate with the reasoning). Charts render the grade as a subtle mark so nobody mistakes an estimate for a fact in a founders' argument.
 
**Research parcelling.** The research briefs above total roughly fifteen to eighteen person-days. The natural split for five people is: one takes the comparables (9) and exit paths (10) because they need Companies House digging; one takes the market seat map (1) and buyer surveys (3); one takes competitors (4) and pricing (2); one builds the model logic (8) and the capacity piece (6) with the team's own assumptions; one owns the design system, the distrust explainer (12) and the accreditation calendar (11). Channel economics (7), the sankeys (5) and the one-pager (13) fall out of the others.
 
**Suggested build order.** First the financial model (8) and the capacity piece (6), because they force the team to write down its assumptions and settle the salary question. Then the comparables trajectories (9), which test those assumptions against reality. Then the market chapter (1–4) to size the opportunity the model presumes. Then the path pieces (11, 12), then the sankeys and channel economics (5, 7) which are derived, then the exit tree (10), and the one-pager (13) last.
 
**Verification step.** Before any piece is shown outside the founding group, someone other than its author reads every number against its source, and the model's outputs are cross-checked against a hand calculation for one scenario. The seat map's builder fractions and the model's ramp assumptions are the two places where a plausible-looking picture can be quietly wrong.