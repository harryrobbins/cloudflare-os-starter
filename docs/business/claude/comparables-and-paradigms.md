# Excelcion — comparable companies and business paradigms
 
*Prepared 25 August 2026. Facts checked against public sources listed at the end; figures are as reported at the time of the cited article and may have moved since.*
 
The brief: businesses that went roughly the route Excelcion is contemplating — a senior technical team, an enterprise wrapper around open-source business tooling, consultancy funding the product — with a bias towards "horses" (companies that reached a good outcome for a small founding team) rather than unicorns. The second half covers the paradigms those companies used and which ones fit a fixed band of five senior engineers.
 
---
 
## Part 1 — The shortlist
 
### A. Consultancy that became a product company (the closest analogues)
 
**Percona (US/remote, 2006–)** — the purest horse. Started as emergency MySQL consulting billed by the hour. Over 2010–14 moved from hourly consulting to support subscriptions; consulting fell from 100% to about 20% of revenue in three to four years. Passed $10m revenue by 2014 and $25–30m by 2019 with ~90% subscription, 200+ staff in 35 countries, fully remote, never took outside investment. Lesson: they never built "a product" in the SaaS sense — they productised *support and managed service around software they didn't originally write* (MySQL, then MongoDB and Postgres), and added their own distributions and tools later. That is very close to "enterprise wrapper around open source".
 
**Fishtown Analytics → dbt Labs (Philadelphia, 2016–)** — the famous service-to-product path, but note the early years, not the unicorn ending. Bootstrapped with $10k, ran as a boutique analytics consultancy for nearly four years while building dbt on the side and in client work. At the point they raised (early 2020) they were ~20 people with 5 engineers supporting ~1,000 companies on the open-source tool. The consulting phase is the template; the VC phase is optional.
 
**Snowplow (London, 2012–)** — Alex Dean and Yali Sassoon ran Keplar LLP, a data consultancy (clients included Jack Wills and the V&A). They open-sourced Snowplow in 2012, sold a managed service deployed *in the client's own cloud* (Snowplow BDP), stayed bootstrapped for seven years and took a £4m Series A from MMC only in 2019. Directly relevant: a UK founder pair, open source plus "private SaaS in your tenancy", consultancy origin.
 
**37signals / Basecamp (Chicago, 1999–)** — web design agency that built Basecamp for itself and clients, switched to product in 2004, took a single minority investment from Bezos Expeditions in 2006 and has otherwise stayed private, profitable and small. The archetype of the "calm company": no exit, profits distributed. Relevant for the "not work too hard" constraint.
 
**Bitnami / BitRock (Seville & SF, 2003–2019)** — founded by Daniel López Ridruejo and Erica Brescia as BitRock (installer tooling), then Bitnami, which packaged open-source apps for one-click deployment on every cloud. Largely bootstrapped (a YC stint aside), acquired by VMware in 2019 for an undisclosed sum. The business was literally "a trusted wrapper around other people's open source" sold to enterprises and cloud marketplaces.
 
**Quansight (Austin, 2018–)** — Travis Oliphant's consultancy; over half the technical staff are core contributors to NumPy, SciPy, PyTorch, Jupyter etc. Client work funds open-source maintenance; the product side is small. Included as the "stay a consultancy but own the ecosystem" pole of the spectrum.
 
### B. Open-source enterprise wrappers that stayed independent
 
**Nextcloud GmbH (Stuttgart, 2016–)** — open-source collaboration suite sold as enterprise subscription (support, LTS, compliance features) to governments, universities and regulated industries; profitable, no external investment, doubled customer base three years running around 2019–20 with 15+ government agencies among its customers. Probably the best European example of "public sector buys the supported open-source wrapper" — precisely your target buyer.
 
**Directus / Monospace (New York, product company from 2020)** — began life inside an agency; open-sourced in 2011; for a decade it was a side project funded by agency work. Incorporated 2020, seed then Series A in 2022. Their licensing journey is instructive: sponsorships failed, they *rejected open core* because it distorted engineering priorities, moved to Business Source Licence in 2022 (free under $5m revenue, paid above) and in 2026 to a Fair-Core-style licence that converts to GPL after four years. The "free for small orgs, paid for enterprises" split is close to what you'd want.
 
**Element / New Vector (London, 2017–)** — commercial company behind Matrix; customers include the German government and other European public bodies. VC-funded (~$30m in 2021) so not bootstrapped, but the cautionary tale matters: their CEO complains that public-sector bodies adopt the open-source core specifically to avoid paying, pushing the company toward proprietary add-ons. Design the paid layer so that the things government *must* have (audit, access control, accreditation support) are the things you charge for.
 
**Redgate Software (Cambridge, 1999–)** — founder-owned database tooling company; no VC, grew to a several-hundred-person, ~$100m business over two decades. Not open source, but the UK proof that a product business can compound quietly without an exit.
 
**Grist Labs (New York)** — small, the tool you're already looking at. Their partner programme is worth copying wholesale: partners keep 100% of consulting fees on self-hosted deployments, get 30% off list on self-hosted enterprise licences, and up to 20% margin reselling SaaS. That is the shape of the channel Excelcion could both *join* (as a Grist/Cloudflare OS partner) and *run* (with other consultancies implementing Excelcion).
 
**Budibase (Belfast, 2019–)** and **Windmill (YC, small team)** — open-source internal-tool/low-code platforms sold self-hosted to enterprises. Both VC-seeded (Budibase $7m), both small; useful as pricing and packaging references for "builder seats vs consumer seats".
 
### C. UK consultancies that exited — the "horse" outcomes on the services side
 
**Infinity Works (Leeds, 2014–2021)** — four founders, cloud/data engineering consultancy, ~440 staff and £50.7m turnover by 2020, minority growth-capital investment in 2019, acquired by Accenture in Feb 2021 (undisclosed). Seven years founding to exit.
 
**Contino (London, 2014–2019)** — DevOps/cloud consultancy, two founders, ~350 staff across UK/US/Australia, acquired by Cognizant in 2019 (undisclosed). Five years.
 
**Made Tech (London, 2008–)** — public-sector digital consultancy, floated on AIM in 2021. Included because it is the UK government-focused version of your consulting motion, and because its post-IPO share price history shows how brutally the market values pure services.
 
**Equal Experts (London, 2007–)** — a network of senior associates rather than a pyramid of juniors, now 100% owned by a trust (2024). The relevant idea is the *staffing model*: senior-only core, flex via a curated associate network. It's how you scale delivery without hiring juniors or breaking up the band.
 
The pattern in section C: these exits took 5–7 years, required scaling headcount to hundreds, and were bought by SIs for revenue and capability, not IP. That path is real but it is the opposite of "not work too hard" and "keep the team at ten".
 
### D. The platform you'd be wrapping
 
**Cloudflare OS (Aug 2026)** — open source, but Cloudflare has said it will bring it to its dashboard as a fully managed product, and has already named Presidio and Happy Cog as implementation partners. Two implications: (1) the managed-Cloudflare-only version of your product will be competing with Cloudflare itself within a year or two; (2) the partner ecosystem is empty right now and being an early named partner is cheap credibility. Your durable differentiation is the bits Cloudflare won't do — on-prem/other-cloud/sovereign hosting, the cross-tool access-control propagation, and public-sector accreditation.
 
---
 
## Part 2 — Paradigms and which ones fit
 
**1. Consultancy-funded product (Fishtown, Snowplow, Basecamp, Percona).** Consulting pays salaries; every engagement is scoped so that reusable pieces land in the product. The discipline that makes it work: a written rule about what percentage of billable capacity is protected for product (Fishtown ran ~3 engineers on dbt while consulting), and IP clauses in every SOW assigning the platform/connector/blueprint work to you, with the client getting a licence.
 
**2. Customer-funded roadmap ("pay us to build the feature you need, we keep it").** Directus, Odoo and most open-core companies do this explicitly: enterprise features are built under paid engagements and become part of the paid tier. For you this is the "blueprints and connectors" consultancy — the first customer pays for the HMRC connector or the Dynamics connector, it ships in the product for everyone. Price these as fixed-scope packages, and put a "sponsored feature" clause in the contract so ownership is unambiguous.
 
**3. Design partners rather than free licences.** The 70k-person client should be a design partner: heavy discount, not zero, in exchange for written case-study, logo and reference rights and a steering seat on the roadmap. A zero price sets your anchor at zero and gives you nothing to point to.
 
**4. Support/assurance subscription, not feature gating (Percona, Nextcloud).** Sell the licence as *insurance* — SLAs, LTS, security patches, accreditation evidence, audit trails — rather than as withheld features. This is what government and regulated buyers actually have budget lines for, and it avoids the open-core incentive problem Directus and Element describe.
 
**5. "Private SaaS" / bring-your-own-cloud (Snowplow BDP, Windmill, Posit).** Managed by you, running in the customer's tenancy. It fits data-sovereignty buyers, keeps you off the hook for hosting costs and makes the access-control story credible (the data never leaves their estate).
 
**6. Fair-source licensing (Directus, and the broader BSL/FCL trend).** Free for organisations under a revenue or headcount threshold, paid above it, converting to a true open-source licence after N years. Gives you adoption plus a legal reason large enterprises must pay, without maintaining two codebases.
 
**7. Channel and partner networks (Odoo, Grist, Cloudflare OS itself).** Odoo's 2,000+ partners do the implementations and earn 10–20% recurring commission on subscriptions; Grist gives partners 30% off self-hosted licences. This is how a ten-person company reaches 25,000 seats: other consultancies (Made Tech, Kainos, the BJSS/CGI world, boutique SIs) implement Excelcion and you take the licence. It also answers the "half the team isn't technical" arithmetic — you don't need to sell 208 days a month if partners sell the days and you sell the seats.
 
**8. Senior-only core plus associate network (Equal Experts).** Keep the five, add flex capacity from trusted associates on a day-rate margin rather than hiring juniors. It keeps the culture and lets you take a large implementation without permanent headcount.
 
**9. Calm company / profit distribution as the liquidity event (Basecamp, Nextcloud, Redgate).** If the honest goal is £2m per founder over 5–10 years, a profitable £3–5m/year company distributing profits gets there without an exit and without a valuation clause in the articles.
 
**10. Consultancy-as-the-exit (Infinity Works, Contino).** Real, UK-proven, 5–7 years, but requires scaling to hundreds of people and is valued on revenue/EBITDA (roughly 1–2x revenue). Product IP is a sweetener in these deals, not the basis. Worth knowing as the fallback if the product doesn't compound.
 
### What I'd take from this for Excelcion
 
The companies most like you (Percona, Snowplow, Fishtown, Nextcloud) all did three things: they spent years as a consultancy while the product matured, they sold *assurance around open source* rather than features, and they let a channel or community carry distribution. None of them started with ten people on full salary. The route that reconciles "keep the band together", "don't hire juniors" and "don't work too hard" is paradigms 1, 4, 7 and 8 together: consultancy funds the first 18–24 months; the licence is an assurance/subscription tied to access-control and audit; partners do most implementations; associates flex capacity. Paradigm 9 (profits as liquidity) is the likely outcome; paradigm 10 is the fallback; a genuine software exit is the upside case, not the plan.
 
---
 
## Sources
 
- Cloudflare: [Cloudflare OS launch post](https://blog.cloudflare.com/cloudflare-os/); [Channel Insider on the partner opportunity](https://www.channelinsider.com/security/managed-services/news-cloudflare-os-enterprise-ai-agents-partners/); [Jamie Lord, "Cloudflare OS is an architecture of distrust"](https://lord.technology/2026/08/05/cloudflare-os-is-an-architecture-of-distrust.html)
- Percona: [Sramana Mitra interview with Peter Zaitsev](https://www.sramanamitra.com/2019/12/18/bootstrapping-a-virtual-company-to-25-million-percona-ceo-peter-zaitsev-part-3/); [Percona 15-year history](https://www.percona.com/wp-content/uploads/2025/06/Percona-15th-Anniversary-Book.pdf)
- dbt Labs: [First Round Review — dbt Labs' path to PMF](https://review.firstround.com/dbt-labs-path-to-product-market-fit/)
- Snowplow: [How and why Snowplow was founded](https://snowplow.io/blog/how-and-why-snowplow-was-founded); [Tech.eu on the £4m round](https://tech.eu/2019/11/15/snowplow-analytics-4-million-opensource-data-collection/)
- Basecamp: [Bezos Expeditions invests in 37signals](https://signalvnoise.com/archives2/bezos_expeditions_invests_in_37signals); [37signals — Wikipedia](https://en.wikipedia.org/wiki/37signals)
- Bitnami: [Bitnami — Wikipedia](https://en.wikipedia.org/wiki/Bitnami); [Bitnami blog: VMware to acquire Bitnami](https://blog.bitnami.com/2019/05/vmware-to-acquire-bitnami.html)
- Quansight: [About Quansight](https://quansight.com/about-us/)
- Nextcloud: [Nextcloud doubles order intake, remains profitable and independent](https://nextcloud.com/blog/nextcloud-doubles-order-intake-and-customer-base-remains-profitable-and-independent/)
- Directus: [1,000+ free licence keys — the story](https://directus.com/resources/1000-license-keys-granted); [Why we're relicensing Directus](https://directus.com/resources/why-we-are-relicensing-directus)
- Element: [The Register — Element bosses on funding open source](https://www.theregister.com/2024/09/25/element_bosses_on_funding_open/); [TechCrunch — Element raises $30M](https://techcrunch.com/2021/07/27/element-a-messaging-app-built-on-the-decentralized-matrix-protocol-raises-30m/)
- Redgate: [Redgate — Wikipedia](https://en.wikipedia.org/wiki/Redgate)
- Grist: [Partner with Grist](https://www.getgrist.com/partners/)
- Budibase: [Silicon Republic — Budibase raises $7m](https://www.siliconrepublic.com/start-ups/budibase-low-code-funding); Windmill: [Y Combinator profile](https://www.ycombinator.com/companies/windmill)
- Infinity Works: [Prolific North — £50m-turnover Leeds firm acquired by Accenture](https://www.prolificnorth.co.uk/news/tech-news/2021/02/ps50m-turnover-leeds-digital-firm-acquired-accenture)
- Contino: [Consultancy.uk — Cognizant buys Contino](https://www.consultancy.uk/news/22735/cognizant-buys-uk-technology-consulting-firm-contino)
- Made Tech: [Why a Made Tech IPO and why now](https://www.madetech.com/blog/why-a-made-tech-ipo-and-why-now/)
- Equal Experts: [The Equal Experts Trust](https://www.equalexperts.com/about-us/equal-experts-trust/)
- Odoo: [ERP Research — Odoo partners, tiers and commissions](https://www.erpresearch.com/en-us/odoo-partners)
 