# Excelcion Atlas — where it lives, what's in it, what's still estimated
 
Atlas (thirteen views, all chapters): https://claude.ai/code/artifact/19e612af-d04d-4c98-9f69-2e1ca52e6ebc
Financial model (interactive): https://claude.ai/code/artifact/5e5cd0e8-58b6-4955-b611-44fe29fdb0ac
 
Data behind it, in this project under `data/`: sectors.json, pricing.json, competitors.json, comparables.json, exits.json, surveys.json. Each has a `meta.sources` list and a grade per figure (A primary, B secondary, C estimate). The Atlas embeds these files; to update a chart, edit the JSON and rebuild.
 
## What is solid (A/B)
- Pricing: UK list prices for Microsoft 365, Copilot (£16.10 list / £13.80 promo, E7 bundle £77), Copilot Studio credits, Google Workspace, ChatGPT/Claude Team, open-source platform tiers.
- Surveys: ONS BICS June 2026 (35% of 10+ firms use AI), Red Hat UK (83% shadow AI), LGA (95% exploring; 62% funding barrier), DBT Copilot trial (21% DAU, 22% hallucinations), Microsoft UK shadow AI, FSB, IAB UK.
- Comparables: Made Tech (annual reports), Percona, dbt, Contino, Infinity Works, Equal Experts (filed accounts), Snowplow round data.
- Exits: MarktoMarket UK smid-cap EV/EBITDA 6.0–6.5x (2024–26); Aventis IT-services sub-$50m 0.6–1.3x revenue; private SaaS 3.1–3.8x ARR; EOT CGT relief cut to 50% from 26 Nov 2025; BADR 18% from April 2026.
## What is still estimated (C) and how to fix it
- Seat map: organisation counts by size band per sector are null — parse BPE 2025 detailed tables Table 5 (xlsx) offline. Advertising (SIC 73) and recruitment internal headcount are order-of-magnitude.
- Builder-fraction ranges per sector are argued estimates.
- Competitive map axis scores are our reading of vendor docs.
- Comparables: Nextcloud, 37signals, Bitnami, Directus, Budibase, Grist revenue points are thin; getlatka figures graded C.
- Channel economics and capacity assumptions are internal.
## Findings worth remembering
- "Half the price of Copilot" holds on seats only if builders are a small share; at 15% builders the seat bill is ~⅓ lower, and model usage decides the rest — BYO key is the argument.
- Only Cloudflare OS (Apache-2.0, early access, partners Presidio and Happy Cog) documents capability-scoped credentials plus observation tracking; it runs only inside a Cloudflare account. Nobody else scores above 2/4 on access-control depth except Palantir (3).
- In the sweat-equity scenario only ~213 product days survive in year 1 (about one engineer full-time) when 48 days a month are billable.