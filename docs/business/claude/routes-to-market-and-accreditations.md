# Excelcion — routes to market and accreditation plan
 
*Prepared 25 August 2026. UK first; EU and US equivalents noted. Prices are ex-VAT ranges reported by UK certification bodies and consultancies in 2026 and will vary by assessor; treat them as budgeting figures, not quotes.*
 
## Summary
 
The buyers who fit "profitable, creative, lightly regulated" and who have the exact problem Excelcion solves are independent advertising, marketing and PR agencies; architecture, engineering and design practices; games, animation and VFX studios; and people-heavy professional services such as consultancies and recruiters. All four have valuable client and commercial data, a workforce already using AI tools without permission (83% of UK organisations report a shadow-AI problem), no in-house platform team, and no sector regulator standing between them and a purchase. The holding companies in advertising have built their own AI platforms (Omnicom's Omni, WPP Open, Publicis CoreAI); the independents beneath them have not, and they compete for the same clients. That gap is the opening.
 
Routes to market should be, in order: founder-led sales into your own networks and the 70k-person design partner; a partner channel of boutique consultancies and MSPs who implement while you take the licence; cloud marketplaces (3% fee, and spend counts against customers' committed cloud budgets) once deals reach five figures; and public-sector frameworks later, because the G-Cloud 15 door has just closed and won't reopen to new suppliers until roughly March 2028.
 
On accreditation, the useful news is that the entry ticket for unregulated commercial buyers is cheap and fast: Cyber Essentials, an ICO registration, insurance and an annual pen test cost under £10k and take weeks. ISO 27001 is the one that unlocks large-enterprise procurement and it costs £25–50k and three to six months in year one; do it early and scope ISO 42001 (the AI management standard) into the same programme, because for a company selling AI governance it is worth more as marketing than as compliance. SOC 2 only matters when US-parented customers appear. Everything else on the list (NHS DSPT, PCI, C5, FedRAMP) belongs to markets you have chosen not to enter.
 
---
 
## 1. What "unregulated" actually means for you
 
No UK sector is free of data law. UK GDPR and the Data Protection Act apply to every customer; what changes between sectors is whether a regulator or a mandatory scheme sits on top of that. Finance (FCA, DORA for EU-facing firms), health (NHS DSPT, CAF), payments (PCI DSS), defence and central government (G-Cloud lot requirements, Secure by Design, security clearances), legal (SRA) and critical infrastructure (NIS regulations, soon the Cyber Security and Resilience Bill) all add a layer. Everything else — agencies, studios, architects, consultancies, recruiters, publishers, property, events, most manufacturing and logistics — is governed by GDPR, contract and the buyer's own security questionnaire. That is the market to start in.
 
Two pieces of AI-specific law are worth having in your sales narrative even in unregulated sectors. From 2 August 2026 the EU AI Act's Article 50 transparency obligations apply (people must be told when they are interacting with an AI system), while the high-risk obligations were pushed back by the Digital Omnibus to December 2027 for standalone systems such as recruitment and to August 2028 for AI embedded in regulated products. Any UK customer with EU clients or staff will be asked about this, and a platform that logs which agent did what, with which data, answers the question for them. Separately, the UK Cyber Security and Resilience Bill passed the Commons in June 2026 and is in Lords committee from 1 September; it will bring "relevant managed service providers" into a NIS-style regime with 24-hour incident reporting, with thresholds set by secondary legislation and substantive effect expected around 2028. If you run a managed version of Excelcion with privileged access to customer systems, assume you will be in scope eventually and design for it now.
 
## 2. Candidate markets
 
The filter used: profitable at the firm level, a large share of knowledge workers who would build things if allowed, sensitive client or commercial data that makes "who can see what" a live worry, no sector regulator, and organisations of 150–3,000 people, which is large enough to need governance and small enough that the CEO or COO can still sign.
 
**Tier 1 — start here**
 
*Independent advertising, marketing and PR agencies and mid-sized networks.* Profitable, fast-moving, heavy users of AI already, and structurally exposed: each agency holds confidential data for many competing clients, so an internal AI tool that can't guarantee client A's data never reaches a deck for client B is unusable. The holding companies have spent heavily on proprietary platforms; the independents are under pressure from the same clients to show equivalent AI capability and governance. Buyer is the CEO, COO or Chief Technology/Data Officer; procurement is light; the IPA, IAB UK and PRCA are the communities. Wedge use cases: client-scoped agent workspaces, pitch and reporting automation on client data, timesheets and utilisation, new-business research.
 
*Architecture, engineering and design practices (AEC).* Partnership-owned, profitable at the top end, drowning in project data (BIM, specifications, fee proposals, RIBA stage documents) and with a professional culture that likes building its own tools. Regulated as professions (ARB, RIBA, ICE) but not as data handlers. Buyer is a managing partner or practice director; RIBA, ACE and the Construction Industry Council are the communities. Wedge: fee and resourcing forecasting, specification and standards lookup with provenance, bid libraries with project-level access control.
 
*Games, animation and VFX studios.* Creative, project-based, large technical staff, and a specific security pattern worth knowing: studios working for the major film and streaming companies are assessed under the Trusted Partner Network (TPN), a content-security scheme run by the Motion Picture Association. It is not a regulator but it behaves like one, and a platform that helps a studio pass TPN by keeping client IP compartmentalised is directly saleable. UKIE, BFI and Animation UK are the communities.
 
**Tier 2 — next**
 
*Management consultancies, recruiters and staffing firms.* Highly profitable per head, entirely data-driven, no sector regulator, and the same multi-client confidentiality problem as agencies. Recruitment adds a GDPR wrinkle (candidate data at scale) but no scheme. Note that from December 2027 recruitment AI is a high-risk category under the EU AI Act for firms operating in the EU, which makes an audit trail a selling point rather than a barrier.
 
*Media and publishing.* Profitable in pockets (B2B publishing, events-led media), with archives, subscriber data and rights metadata that make provenance tracking valuable. Good fit but longer sales cycles.
 
*Mid-cap manufacturing, logistics and property.* Large operational data estates, low regulation, but conservative IT buying and a preference for ERP-vendor tooling. Better reached through partners than directly.
 
**Deliberately later**
 
Law and accountancy (SRA and ICAEW rules on confidentiality and outsourcing make procurement slow, though the need is acute), financial services (FCA, DORA), health (DSPT), central government and defence (frameworks, clearances). These are where the licences are big, but each needs the accreditation ladder in section 4 completed first, and the 70k-person design partner already gives you a large-enterprise reference without a second procurement fight.
 
## 3. Routes to market
 
**Founder-led direct sales through your own networks.** For the first ten customers nothing else works as well. Five senior engineers who have consulted across enterprises have between them a few hundred warm contacts; the offer to each is the fixed-scope "secure landing" package rather than a licence pitch, because a package with a price and an end date is something a COO can approve in one meeting. The design partner is the proof; get the case-study rights before the platform is live.
 
**Partner channel.** The arithmetic in your plan only closes if other people do the implementations. Three kinds of partner matter. Boutique digital consultancies and MSPs serving agencies and AEC firms already have the client relationships and want an AI governance story to sell; offer them the Grist-style deal (they keep implementation fees, get 25–30% off licence list, and earn a recurring commission of 10–20% for the first year). Cloudflare itself is a partner in the sense that the Cloudflare OS partner list is currently two firms long (Presidio and Happy Cog); being the named UK implementation partner costs a conversation with their partner team and buys credibility with every prospect who has read the launch post. And the parent contractor on your current engagement is a partner already, which is the cleanest way to get the 70k-person client onto the platform without a conflict.
 
**Cloud marketplaces.** AWS, Azure and Google all charge 3% on public SaaS listings and on private offers under $1m, falling to 1.5% on renewals. The reason to list is not the storefront but that marketplace purchases count against the customer's committed cloud spend, which turns "new budget line" into "money already allocated" for any enterprise on an AWS or Azure commit. Listing is free; being transactable takes a few weeks of integration work. Do it once deal sizes justify it, probably year two.
 
**Open source, content and community.** The comparables doc showed that Percona, Snowplow and Nextcloud all let the open-source core and the founders' writing carry distribution. The "architecture of distrust" argument is exactly the kind of thing that gets read by the CTOs of 500-person agencies; one of the five should own a publishing cadence from day one. Industry bodies (IPA, IAB UK, RIBA, UKIE) run member events and supplier directories that are cheap to be in.
 
**Public-sector frameworks (later).** G-Cloud 15 closed to applications on 30 January 2026, goes live in September 2026 as a four-year "open framework", and under the Procurement Act 2023 reopens to new suppliers 18 months after go-live, so around March 2028. It now requires Cyber Essentials for all lots, £7m of combined insurance for the SaaS and support lots, and ISO 9001, 20000-1, 27001 and 27018 only if you host infrastructure (lot 1). Digital Outcomes and Specialists 7 (DOS7) replaced the Digital Specialists and Programmes framework in 2026 and is the route for consultancy work. Until 2028 the practical route into government is as a subcontractor or reseller through a partner already on G-Cloud, which is also what your current engagement looks like.
 
## 4. The accreditation ladder
 
The table is ordered by when you need each one. "Who asks" is what buyers in the target sectors actually put in questionnaires, not what is theoretically required.
 
| Accreditation | Who asks for it | Cost (ex VAT) | Time | Validity | Notes |
|---|---|---|---|---|---|
| ICO registration (data protection fee) | Legal requirement for any UK data controller | £52–£3,763/yr by size (tier 1 for a 10-person firm) | Same day | Annual | Table stakes; do it at incorporation |
| Cyber Essentials | Almost every UK questionnaire; mandatory for all G-Cloud 15 lots within 12 months of award | £320 (1–9 staff), £440 (10–49) | Days to a few weeks (self-assessment) | 12 months | IASME-run; the 2026 question set covers cloud services and MFA |
| Cyber Essentials Plus | Larger commercial buyers, most public bodies | Audit typically £1,500–£4,000; £5k average including remediation | 1–3 day audit; must hold basic CE from within the previous 3 months | 12 months | Independent technical audit of the same controls |
| Professional indemnity, public liability, cyber insurance | Every contract; G-Cloud requires £1m PI, £1m PL, £5m EL | Low thousands per year for a 10-person tech firm at £1–2m PI; more with cyber cover | Days | Annual | Get quotes with the ISMS scope in hand; premiums fall with CE Plus/ISO 27001 |
| Annual penetration test | Enterprise questionnaires; ISO 27001 evidence | £5,000–£15,000 per test for a platform of this size | 1–2 weeks | Annual | Use a CREST-member firm; publish a summary letter |
| ISO 27001 (UKAS-accredited) | Enterprises over ~1,000 staff, all regulated buyers, many agencies' own clients | Certification body £4–12k over the 3-year cycle; consultancy-led implementation £25–50k first year; self-run much less given the team | 3–6 months implementation, then stage 1 and stage 2 audits | 3-year cycle with annual surveillance | The single accreditation that changes what you can sell; insist on a UKAS-accredited body |
| ISO 42001 (AI management system) | Beginning to appear in enterprise and public-sector questionnaires; not yet mandated anywhere | £6–8k audit fees for a small firm; total low-to-mid five figures | 3–6 months if ISO 27001 exists, 9–18 months from scratch | 3-year cycle | For an AI-governance vendor this is a differentiator; scope it alongside 27001 |
| SOC 2 Type II | US-parented customers, US VC-backed scale-ups | Auditor $15–45k; $30–150k all-in first year including tooling | 6–12 months (1–3 months readiness, 3–12 months observation, 4–8 weeks reporting) | Annual report | Skip until a US buyer asks; controls overlap heavily with 27001 |
| TPN (Trusted Partner Network) | Film, TV and streaming clients of VFX/animation studios | Studio-side cost; vendors help customers pass rather than hold it | Varies | Annual | Relevant to selling into studios, not to Excelcion directly |
| NHS DSPT | Any NHS/care supplier; mandatory for IT suppliers over 50 staff or £10m turnover | Internal effort; annual independent assessment | Months | Annual | Health only; now CAF-aligned |
| PCI DSS | Anyone touching cardholder data | Significant | Months | Annual | Avoid by never handling card data |
| G-Cloud 15 / DOS7 listing | UK public sector | Free to apply; insurance and CE required | G15 next window ~March 2028; DOS7 live now | Framework term | Sell via a partner until then |
| EU: NIS2, DORA, C5 (Germany), SecNumCloud (France) | EU critical sectors, finance, public sector | Substantial | Long | Ongoing | Out of scope for the first two years; ISO 27001 is the common foundation |
| US: FedRAMP / StateRAMP | US public sector | Very substantial | 12–24 months | Ongoing | Out of scope |
 
## 5. Sequencing and budget
 
The sensible order runs like this. In the first quarter, at incorporation, do the ICO registration, Cyber Essentials, insurance and a first pen test of the platform, and start the ISO 27001 information security management system on day one rather than retro-fitting it, because the policies, asset registers and access reviews you write are also the artefacts your product generates for customers. Total cash cost under £10k; time cost a week or two spread across the team.
 
Between months three and nine, take Cyber Essentials Plus and go for ISO 27001 certification with a UKAS-accredited body, and scope ISO 42001 into the same management system so the second certificate is an incremental audit rather than a second programme. If you self-run using open-source policy sets and a lightweight compliance tool rather than a consultancy, the cash cost is roughly £15–25k for the two certifications plus £8–12k a year of tooling, against £40–60k if you hire it in. Budget a third of one person's time for six months. This is the point at which you can answer any commercial buyer's questionnaire without caveats and most enterprises' without escalation.
 
In year two, add SOC 2 only if a US-parented customer requires it, list on AWS and Azure marketplaces when deal sizes reach the low tens of thousands, and prepare the G-Cloud 15 submission for the 2028 window. Watch the Cyber Security and Resilience Bill's secondary legislation for the MSP thresholds; if your managed tier grows, registration and 24-hour incident reporting arrive around 2028.
 
The total accreditation budget for the first eighteen months, done mostly in-house, is in the £40–60k range including insurance and pen testing, which is a small fraction of the cost base in your plan and buys access to every market in tiers one and two.
 
## 6. What buyers in these sectors will actually send you
 
Expect a security questionnaire (often the Cloud Security Alliance CAIQ or a home-grown spreadsheet of 100–300 questions), a request for your data processing agreement and sub-processor list (which, for a BYO-key product, is short and is itself a selling point), evidence of Cyber Essentials, a pen-test summary, insurance certificates, and increasingly a question about AI governance that no one has a standard for yet. Having ISO 27001 collapses the questionnaire to a certificate. Having ISO 42001 and a product whose whole purpose is auditable, revocable access answers the AI question before it is asked. For a company whose thesis is that the platform must not trust the agent, being visibly trustworthy yourselves is the cheapest marketing available.
 
---
 
## Sources
 
- Cyber Essentials pricing and process: [IASME price bands via cyberessentialspluscertification.co.uk](https://cyberessentialspluscertification.co.uk/cost/); [CyberOne on Cyber Essentials Plus costs](https://cyberone.security/blog/cyber-essentials-plus-certification-cost-uk-2026-strategic-guide)
- ISO 27001 costs and timeline: [Intelance ISO 27001 cost UK](https://www.intelance.co.uk/iso-27001-cost-uk/)
- ISO 42001: [QL Security — ISO 42001 certification cost and timeline](https://qlsecurity.co.uk/insights/iso-42001-certification-cost/)
- SOC 2: [SOC 2 Type 2 audit cost breakdown](https://soc2auditors.org/insights/soc-2-type-2-audit-cost/)
- G-Cloud 15: [Computer Weekly — everything you need to know](https://www.computerweekly.com/feature/UK-governments-G-Cloud-15-framework-Everything-you-need-to-know); [Burges Salmon — key changes for suppliers](https://www.burges-salmon.com/articles/102lzf5/g-cloud-15-g15-framework-key-changes-for-uk-public-sector-cloud-suppliers/); [Computer Weekly — SME criticism](https://www.computerweekly.com/news/366634470/CCS-under-fire-over-anti-SME-supplier-requirements-for-G-Cloud-15)
- DOS7 and the expired DSP framework: [GCA RM6263 page](https://www.gca.gov.uk/agreements/RM6263); [UKAuthority — GCA launches DOS 7](https://www.ukauthority.com/articles/new-government-commercial-agency-launches-dos-7)
- NHS DSPT: [RSM UK — Data Security and Protection Toolkit](https://www.rsmuk.com/insights/advisory/data-security-and-protection-toolkit)
- EU AI Act and the Digital Omnibus: [Gibson Dunn — postponed high-risk deadlines](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/); [Jones Walker — August 2 still matters](https://www.joneswalker.com/en/insights/blogs/ai-law-blog/yes-august-2-still-matters-the-eu-approved-a-high-risk-ai-delay-but-most-trans.html)
- Cyber Security and Resilience Bill: [ComplianceHub — Lords committee September 2026](https://compliancehub.wiki/uk-cyber-security-resilience-bill-lords-committee-september-2026-msp-data-centre-scope/); [Hansard, 16 June 2026](https://hansard.parliament.uk/commons/2026-06-16/debates/708ABEA8-7C84-4921-A3E8-C1E955DA8C5F/CyberSecurityAndResilience(NetworkAndInformationSystems)Bill)
- Cloud marketplace fees: [AWS Marketplace listing fees](https://docs.aws.amazon.com/marketplace/latest/userguide/listing-fees.html); [Partner1 — marketplace fees compared](https://www.partner1.io/partner-blog/cloud-marketplace-fees-compared)
- Cloudflare OS partners: [Channel Insider](https://www.channelinsider.com/security/managed-services/news-cloudflare-os-enterprise-ai-agents-partners/)
- Shadow AI and UK buyer concerns: [Red Hat UK survey](https://www.redhat.com/en/about/press-releases/red-hat-survey-uk-organizations-ready-widespread-ai-adoption-skills-gaps-high-costs-and-shadow-ai-threaten-ambition)
- Agency AI platforms: [eMarketer — FAQ on ad agencies 2026](https://www.emarketer.com/content/faq-on-ad-agencies--consolidation--ai-disruption--what-s-changing-2026); [The Media Leader — agency groups' AI platforms explained](https://uk.themedialeader.com/agency-groups-ai-platforms-explained/)
- Grist partner terms (channel model reference): [Partner with Grist](https://www.getgrist.com/partners/)