# Naming league: review pack

# Naming league

An adversarial tournament in which ten cost-efficient LLMs propose company names, judge each other
blind against a weighted rubric, and halve the field each round until one name is left. It also
tests how the rules change the result, as a pilot for using adversarial panels in research.

## Flow

1. `python3 league.py propose` asks every model for three names (`--fill` re-asks any that failed)
   and plants a bland control name.
2. Every name gets the same impartial research: `../namecheck.py all` for Companies House and
   domains, then a web search for meaning, existing companies and associations. The results go in
   `results/dossier.json` (the text the judges see) and `results/dossier-facts.json`.
3. `python3 league.py run A B C --repeats N --first-repeat K` plays the rounds. Each round is
   advocate → panel → Jev: a model that did not propose a name argues for it, all ten judges score
   every name on the rubric, and in variant B Jev scores every criterion. Judges are never told
   which names are theirs. Their scores for their own names are dropped from the tally and kept to
   measure self-preference.
4. `python3 analyze.py` writes `results/summary.json`; `python3 build_report.py` renders
   `report.html`.

| Variant | Rules |
|---|---|
| A | Panel, plus points for backing the eventual winner early (16/8/4/2/1 by round) |
| B | As A, with Jev (TypeSafe's decision model, via OpenRouter) weighted equal to the whole panel |
| C | Panel only: no backing, no incentive, no Jev |

## Setup

LLM calls go through the LiteLLM proxy with this experiment's own virtual key, capped at $12 and
expiring on 2026-10-01. `.env.local` here holds `LITELLM_PROXY_API_KEY` and
`LITELLM_PROXY_API_BASE=http://localhost:30200`, so open the tunnel first:
`ssh -N -L 30200:127.0.0.1:30200 ms`. Jev reads `OPENROUTER_API_KEY` from the repo-root
`.env.local`. Each run stops itself at $3.

Every call, with its tokens and the proxy's reported cost, is logged to `results/*.calls.jsonl`.


## Brief given to the judges

THE COMPANY. A UK founder-led business (working name Excelcion, which cannot be used). It builds
polished AI applications and workflows on an open-source agent platform (Cloudflare OS), demonstrates
them to prospects, offers trial licences, and sells fixed-price consultancy that leads to recurring
licence revenue. Buyers are mid-market and enterprise: CFOs, CISOs, COOs, heads of operations, often
in regulated UK sectors. Its thesis is an architecture of distrust: AI agents hold only the
capabilities they are granted, risky actions wait for human approval, and information flows only
where it may. It aims to be worth £100m.

THE MARKET. It competes for attention with Microsoft Copilot and Copilot Studio, Google Gemini
Enterprise, ChatGPT Enterprise, Claude Enterprise, Palantir AIP, Glean, Databricks and Snowflake AI,
low-code tools (Retool, Power Platform) and UK consultancies (Kainos, Made Tech, BJSS, Faculty).
Useful name comparisons: Palantir and Anduril (literary borrowings), Thought Machine, Darktrace,
Tailscale, Snowflake; and consultancy-to-product firms such as Fishtown Analytics (dbt Labs),
Snowplow and Percona. AI-security brand space is crowded with shield, guard, sentinel and aegis
names, and most sturdy single English words are already registered at Companies House.

THE NAME MUST be sober enough for a CISO, memorable after one hearing, a little wry but never silly,
registrable as a UK company, with a usable domain, and must not be confused with an existing AI,
security or software company.

## Rubric

- fit (30%): Fit: tells the architecture-of-distrust story (granted capability, human approval, controlled flow).
- gravitas (25%): Gravitas: a CFO or CISO would trust a company with this name; sober, not silly.
- distinct (20%): Distinctiveness: memorable, easy to say and spell, stands out from shield/guard/sentinel clichés.
- ownable (25%): Ownability: judged from the dossier: Companies House, domains, clashes with existing companies.

## Results: 15 runs, total cost $7.04

- A1: winner Countermand Labs; final Countermand Labs 8.60 vs Claustra Labs 8.08
- A2: winner Countermand Labs; final Countermand Labs 8.62 vs Claustra Labs 8.18
- A3: winner Countermand Labs; final Countermand Labs 8.94 vs Claustra Labs 7.71
- A4: winner Claustra Labs; final Claustra Labs 8.78 vs Countermand Labs 8.24
- A5: winner Countermand Labs; final Countermand Labs 8.93 vs Claustra Labs 7.71
- B1: winner Countermand Labs; final Countermand Labs 8.66 vs Claustra Labs 7.89
- B2: winner Countermand Labs; final Countermand Labs 8.61 vs Claustra Labs 7.99
- B3: winner Countermand Labs; final Countermand Labs 8.63 vs Claustra Labs 8.13
- B4: winner Countermand Labs; final Countermand Labs 8.71 vs Claustra Labs 7.96
- B5: winner Countermand Labs; final Countermand Labs 8.68 vs Claustra Labs 8.00
- C1: winner Claustra Labs; final Claustra Labs 8.42 vs Countermand Labs 8.29
- C2: winner Countermand Labs; final Countermand Labs 8.74 vs Claustra Labs 8.05
- C3: winner Claustra Labs; final Claustra Labs 8.24 vs Countermand Labs 8.08
- C4: winner Countermand Labs; final Countermand Labs 8.19 vs Claustra Labs 8.01
- C5: winner Countermand Labs; final Countermand Labs 8.47 vs Claustra Labs 8.02

## Variant measures (averages)

- A: wins Countermand Labs 4, Claustra Labs 1; herding towards shared mean 0.009 pts; mean rescore move 0.49; self-preference 0.11; judge corr 0.88 (clear names only 0.76); effective judges 1.13 (clear only 1.28); Jev-panel corr None; control out round 1; cost $2.33
- B: wins Countermand Labs 5; herding towards shared mean -0.011 pts; mean rescore move 0.46; self-preference 0.13; judge corr 0.88 (clear names only 0.74); effective judges 1.12 (clear only 1.32); Jev-panel corr 0.9685168018363521; control out round 1; cost $2.30
- C: wins Claustra Labs 2, Countermand Labs 3; herding towards shared mean -0.015 pts; mean rescore move 0.46; self-preference 0.13; judge corr 0.90 (clear names only 0.77); effective judges 1.10 (clear only 1.26); Jev-panel corr None; control out round 1; cost $2.23

## Backing behaviour (A and B)

- A1: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 1, gemini-3.8-flash 1, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 1, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 2; picks equal to previous round's leader: gpt-5.6-luna 3/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 4/4
- A2: first correct round by model: gpt-5.6-luna 3, claude-sonnet-5 4, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 3, nemotron-ultra 2, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 4; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 3/4, gemini-3.8-flash 3/4, deepseek-v4-pro 3/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 3/4, gpt-oss-120b 3/4, gemma-4-31b 3/4, claude-haiku-4.5 2/4
- A3: first correct round by model: gpt-5.6-luna 1, claude-sonnet-5 2, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 2, gpt-oss-120b 1, gemma-4-31b 2, claude-haiku-4.5 1; picks equal to previous round's leader: gpt-5.6-luna 3/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 3/4
- A4: first correct round by model: gpt-5.6-luna 1, claude-sonnet-5 1, gemini-3.8-flash 3, deepseek-v4-pro 1, deepseek-v4-flash 2, minimax-m3 1, nemotron-ultra 3, gpt-oss-120b 2, gemma-4-31b 2, claude-haiku-4.5 2; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 4/4, gemini-3.8-flash 2/4, deepseek-v4-pro 3/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 3/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 4/4
- A5: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 4, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 2, minimax-m3 2, nemotron-ultra 2, gpt-oss-120b 1, gemma-4-31b 2, claude-haiku-4.5 2; picks equal to previous round's leader: gpt-5.6-luna 3/4, claude-sonnet-5 2/4, gemini-3.8-flash 3/4, deepseek-v4-pro 3/4, deepseek-v4-flash 3/4, minimax-m3 3/4, nemotron-ultra 3/4, gpt-oss-120b 3/4, gemma-4-31b 3/4, claude-haiku-4.5 3/4
- B1: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 2, gemini-3.8-flash 1, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 2, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 2; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 4/4
- B2: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 1, gemini-3.8-flash 1, deepseek-v4-pro 2, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 1, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 3; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 3/4, gemma-4-31b 4/4, claude-haiku-4.5 3/4
- B3: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 1, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 1, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 3; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 2/4
- B4: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 2, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 1, nemotron-ultra 2, gpt-oss-120b 1, gemma-4-31b 1, claude-haiku-4.5 2; picks equal to previous round's leader: gpt-5.6-luna 4/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 4/4
- B5: first correct round by model: gpt-5.6-luna 2, claude-sonnet-5 1, gemini-3.8-flash 2, deepseek-v4-pro 1, deepseek-v4-flash 1, minimax-m3 2, nemotron-ultra 2, gpt-oss-120b 2, gemma-4-31b 1, claude-haiku-4.5 1; picks equal to previous round's leader: gpt-5.6-luna 3/4, claude-sonnet-5 4/4, gemini-3.8-flash 4/4, deepseek-v4-pro 4/4, deepseek-v4-flash 4/4, minimax-m3 4/4, nemotron-ultra 4/4, gpt-oss-120b 4/4, gemma-4-31b 4/4, claude-haiku-4.5 2/4

## Model league (all runs)

| model | proposer pts | backing pts | judge accuracy | self-pref | cost |
|---|---|---|---|---|---|
| deepseek-v4-pro | 189 | 292 | 0.78 | -0.1 | $2.42 |
| deepseek-v4-flash | 97 | 270 | 0.77 | 0.3 | $0.72 |
| nemotron-ultra | 126 | 190 | 0.75 | 0.1 | $0.00 |
| gemma-4-31b | 16 | 262 | 0.79 | 0.25 | $0.00 |
| minimax-m3 | 53 | 174 | 0.78 | -0.17 | $0.50 |
| claude-sonnet-5 | 15 | 206 | 0.81 | -0.36 | $2.33 |
| gpt-oss-120b | 16 | 196 | 0.68 | 0.47 | $0.11 |
| gemini-3.8-flash | 0 | 189 | 0.77 | -0.22 | $0.33 |
| gpt-5.6-luna | 28 | 160 | 0.77 | 0.66 | $0.10 |
| claude-haiku-4.5 | 0 | 134 | 0.71 | 0.56 | $0.52 |

## Every candidate (sorted by wins, finals, mean round-1 score)

### Countermand Labs (C15) — proposed by deepseek-v4-pro
Pitch: Countermand means revoking an order, capturing the human power to stop risky AI actions before they proceed.
Wins 12/15; finals 15; best round reached 6; mean round-1 score 8.06
Research: Companies House clear; free domains countermandlabs.com, countermandlabs.co.uk, countermandlabs.ai, countermandlabs.io; meaning: "To countermand": to cancel an order by issuing a contrary one. Existing uses: None found under this name. Nearby but unrelated: Counter Labs (restaurant software), CounterLabs.ai (placeholder), Counter Lab (Duke research group). Associations: Strong military command-and-control connotation.
Round-1 critiques (run A1, harshest first): Countermand = revoke order, fits human override; all domains free; military tone acceptable. | Sharp fit, sober, clean, fully available | Strong command-and-control fit; rare-word risk for buyers. | Perfect fit; professional, distinct, and highly ownable. | Revoking orders captures human stop; clear, ownable, distinctive. | Superb fit for human-in-the-loop override; clean legal path and domains. | Strong fit; military tone; clean ownership. | Outstanding stop-authority metaphor with clear registration, domains, and no material namesake.

### Claustra Labs (C24) — proposed by nemotron-ultra
Pitch: Latin for barred gates and grates—the physical architecture of 'information flows only where it may,' rendered sober and weighty.
Wins 3/15; finals 15; best round reached 6; mean round-1 score 7.90
Research: Companies House clear; free domains claustralabs.com, claustralabs.co.uk, claustralabs.ai, claustralabs.io; meaning: Latin "claustra": bar, bolt, lock or enclosure (root of "cloister" and "claustrophobia"). Existing uses: None found in AI, security or software. Associations: In French, a claustra is a perforated screen wall (building materials); root of "claustrophobia".
Round-1 critiques (run A1, harshest first): Dignified architectural gating concept with clear registration and clean domains. | Sober Latin gatekeeping image, clean and available | Barred gates fit; Latin weight; claustrophobia connotation slightly dampens. | Latin barred-gate story, very ownable; claustrophobia echo and obscurity may hurt. | Latin 'barred gates' directly maps to controlled flow; clean. | Claustra = barred gates, perfect fit; Latin gravitas; all domains free; obscure but sober. | Distinctive, weighty enclosure metaphor with clean research and excellent domain availability. | Strong architectural metaphor; perfectly ownable.

### Penstock Labs (C23) — proposed by minimax-m3
Pitch: The sluice-gate that meters a river — Penstock fits an architecture admitting capability and information only where, and when, they should.
Wins 0/15; finals 0; best round reached 4; mean round-1 score 7.64
Research: Companies House clear; free domains penstocklabs.com, penstocklabs.co.uk, penstocklabs.ai, penstocklabs.io; meaning: A penstock is a sluice, gate or pipe controlling water flow, e.g. to a hydroelectric turbine. Existing uses: Penstock Group (penstockgroup.com), healthcare payment-integrity SaaS, Inc. 5000 #353 in 2025; Pentera, a well-funded pen-testing platform (similar sound); Penstock Coffee Roasters. No "Penstock Labs" found. Associations: Possible sound-alike confusion with Pentera.
Round-1 critiques (run A1, harshest first): Good flow metaphor; sound-alike risk with Pentera | Penstock = sluice gate, excellent fit; all domains free; Pentera sound-alike risk minor. | Sluice-gate fit; industrial gravitas; Pentera sound-alike weakens distinctiveness. | Industrially sober; good fit and availability. | Strong mechanical metering metaphor; clean UK registry and available domains. | Excellent controlled-flow metaphor, though Penstock and Pentera may be confused aloud. | Sluice-gate control metaphor, available domains; sound-alike Pentera and healthcare SaaS connection. | Strong metaphor; sound-alike Pentera risk.

### Runnymede Labs (C25) — proposed by deepseek-v4-flash
Pitch: At Runnymede, power accepted limits; AI agents should act only within granted boundaries.
Wins 0/15; finals 0; best round reached 4; mean round-1 score 7.58
Research: Companies House clear; free domains runnymedelabs.co.uk, runnymedelabs.ai, runnymedelabs.io, runnymede-labs.com; meaning: Runnymede is the Thames-side meadow in Surrey where King John sealed Magna Carta in 1215. Existing uses: The Runnymede Corporation (US commercial real estate); Runnymede Borough Council; the Runnymede Trust (a prominent UK race-equality think tank). No "Runnymede Labs" tech company found. Associations: Magna Carta and the rule of law; the name of a UK council and a well-known charity.
Round-1 critiques (run A1, harshest first): Magna Carta gravitas; minor charity-name overlap | Magna Carta gravitas, but UK council and race-equity trust. | Evokes constitutional power limits nicely, though overlaps with prominent UK entities. | Rule-of-law associations suit governance, but council and charity recognition dilute ownership. | Good gravitas; overlap with UK charity/council. | Historical; council/charity name; no .com. | Magna Carta limits are powerful, sober, British; slight charity/council association, no .com. | Magna Carta = rule of law, exceptional fit; all domains free; UK gravitas; only

### Imprimatur Labs (C16) — proposed by deepseek-v4-pro
Pitch: Imprimatur means official approval, fitting a firm where risky AI actions wait for human sign-off.
Wins 0/15; finals 0; best round reached 4; mean round-1 score 7.56
Research: Companies House clear; free domains imprimaturlabs.com, imprimaturlabs.co.uk, imprimaturlabs.ai, imprimaturlabs.io; meaning: Latin "let it be printed": a Catholic bishop's official permission to publish; by extension, official sanction. Existing uses: None found as "Imprimatur Labs". Imprimatur Group (imprimatur.co.uk), 30-year UK automotive translation firm with an AI translation product; Imprimatur Capital Ltd, venture capital. Associations: Catholic ecclesiastical-censorship connotation.
Round-1 critiques (run A1, harshest first): Plausible approval theme but heavy ecclesiastical censorship baggage lingers. | Distinctive approval metaphor; mild ecclesiastical odour | Latin 'official approval' on-brief; Catholic censorship may jar. | Approval sign-off fit; weighty Latin; existing group and censorship edge. | Imprimatur = approval; strong fit; all domains free; Catholic connotation minor vs gravitas gain. | Precisely conveys formal approval, with strong ownability despite ecclesiastical overtones. | Academic gravitas; distinct; clear ownership. | Ecclesiastical connotation; otherwise strong.

### Chary Labs (C26) — proposed by nemotron-ultra
Pitch: Chary means cautiously reluctant—exactly the posture of least-privilege agents, mandatory approval gates, and need-to-know data flows.
Wins 0/15; finals 0; best round reached 4; mean round-1 score 7.32
Research: Companies House clear; free domains charylabs.com, charylabs.co.uk, charylabs.ai, charylabs.io; meaning: "Chary" means cautious, wary, reluctant (Old English "cearig"). Existing uses: None found in AI or software. Chary.nl (Dutch e-commerce marketing agency); Chary Law (US law firm). Associations: Uncommon word; risk of mispronunciation or misreading as "charity".
Round-1 critiques (run A1, harshest first): Great conceptual fit for cautious agents, but risks sounding like charity. | Apt cautious tone; risk of mispronunciation | Least-privilege meaning fits; misreading as charity and pronunciation risk weaken distinctiveness. | Concise least-privilege signal and highly ownable, though charity mishearing is possible. | Chary = cautious, fits distrust posture; all domains free; uncommon word, mispronunciation risk. | Excellent fit, but lacks gravitas; sounds like charity. | Cautious least-privilege fit; ownable; risks sounding weak, charity. | Cautious maps to least-privilege; mild 'charity' mishearing risk.

### Provost Labs (C30) — proposed by deepseek-v4-flash
Pitch: A provost governs by consent and check; AI agents should hold only delegated authority.
Wins 0/15; finals 0; best round reached 4; mean round-1 score 7.16
Research: Companies House clear; free domains provostlabs.com, provostlabs.co.uk, provostlabs.ai, provostlabs.io; meaning: A provost is a senior official: head of a university, a Scottish burgh's chief magistrate, or a military-police officer. Existing uses: Provost Companies Inc (US landscaping); university "Office of the Provost" AI initiatives. No "Provost Labs" tech company found. Associations: Strongly associated with university administration; may read as institutional.
Round-1 critiques (run A1, harshest first): Good governance meaning; reads as university office, not AI. | Governance implication is credible and ownable, though university associations dominate. | Institutional, university-flavoured but sober and ownable | Delegated authority fits, ownable; university administration connotation may limit enterprise tech feel. | Clean registry, excellent delegated governance metaphor, fits UK institutional tone. | Professional, but reads as university administration. | Provost = governed by consent; all domains free; strongly institutional, may read as university. | University admin association; otherwise clean.

### Seneschal Labs (C29) — proposed by deepseek-v4-flash
Pitch: A seneschal stewards power under strict instruction; our agents act only when explicitly granted.
Wins 0/15; finals 0; best round reached 3; mean round-1 score 6.94
Research: Companies House clear; free domains seneschallabs.com, seneschallabs.co.uk, seneschallabs.ai, seneschallabs.io; meaning: A seneschal was a medieval steward who ran a lord's household, estate administration and justice. Existing uses: Only small open-source projects (a voice-bot and an AI workflow engine on GitHub) and a small Dubai tenancy platform. No major company. Associations: Archaic, hard to spell and say; common in fantasy fiction and role-playing games.
Round-1 critiques (run A1, harshest first): Clean domains but overly archaic, difficult to spell, sounds like fantasy roleplay. | Archaic, fantasy-game connotations, but clean and ownable | Steward story fits, but archaic spelling/pronunciation and fantasy feel reduce gravitas. | Seneschal steward metaphor strong; all domains free; archaic, hard to spell and pronounce. | Sober, but archaic and hard to say. | Delegated stewardship fits strongly, but pronunciation, spelling, and fantasy associations hinder recall. | Steward meaning solid; fantasy/RPG associations sap enterprise feel. | Archaic; fantasy associations; domains free.

### Bailiwick Labs (C22) — proposed by deepseek-v4-pro
Pitch: Bailiwick means one's rightful domain, fitting AI agents confined to approved capabilities and information boundaries.
Wins 0/15; finals 0; best round reached 3; mean round-1 score 6.89
Research: Companies House clear; free domains bailiwicklabs.co.uk, bailiwicklabs.ai, bailiwicklabs.io, bailiwick-labs.com; meaning: A bailiwick is the district or jurisdiction of a bailiff; by extension, one's area of authority. Existing uses: Bailiwick (bailiwick.com), a Fortune 500 managed IT/site-services provider; Bailiwick Ventures, digital-transformation consulting; Bailiwick VIBE, an AI venture studio. No "Bailiwick Labs" found. Associations: Best known as the Bailiwicks of Jersey and Guernsey, associated with offshore finance.
Round-1 critiques (run A1, harshest first): Offshore-finance association undercuts trust signal | Fortune 500 owns bailiwick.com; offshore finance connotations. | Intriguing jurisdictional metaphor, clear Companies House path, but slightly bureaucratic. | Jurisdiction boundary fit; no .com; existing Bailiwick firms. | Bailiwick = rightful domain, fits architecture; all domains free; offshore-finance association weak. | Clear, but association with offshore finance. | Offshore finance association; otherwise clean. | Strong jurisdiction metaphor and memorable sound, tempered by offshore and managed-services associations.

### Veto Labs (C12) — proposed by gemma-4-31b
Pitch: A wry nod to the human-in-the-loop, ensuring risky AI actions require explicit human approval.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 6.88
Research: Companies House clear; free domains vetolabs.co.uk, vetolabs.ai, vetolabs.io, veto-labs.com; meaning: "Veto" is Latin for "I forbid": the power to block an action unilaterally. Existing uses: veto.so, "Stop risky AI actions before they happen", runtime authorisation for AI agents, closely matching this thesis; Ona's "Veto", a kernel-level enforcement engine for AI-agent security (Ona, formerly Gitpod, is a funded dev-tools company); VetoAI, an AI legal drafting tool (India); Veto Technologies, privacy communications devices. Associations: Widely used in politics (UN Security Council veto); short and easy to say.
Round-1 critiques (run A1, harshest first): Strong thematic fit but crowded by active AI competitors using Veto. | Human veto fit; short and clear; close AI-agent authorization clashes. | Perfect thesis fit; direct clash with veto.so competitor | veto.so already runs this exact thesis; memorable but crowded. | Perfect human-block meaning but used by related AI security tools; domains limited. | Exceptionally clear approval metaphor, but closely overlaps existing AI-agent veto products. | Excellent fit: veto = human approval; wry and sober; strong domains; minor competitor veto.so. | Strong fit; 'Veto' used by rival AI-authorisation tools.

### Anchorite Labs (C27) — proposed by minimax-m3
Pitch: The medieval anchorite was walled into a cell by choice — wry, weighty shorthand for capability held strictly to its granted bounds.
Wins 0/15; finals 0; best round reached 3; mean round-1 score 6.88
Research: Companies House clear; free domains anchoritelabs.co.uk, anchoritelabs.ai, anchoritelabs.io, anchorite-labs.com; meaning: An anchorite is a religious hermit, historically sealed into a cell attached to a church. Existing uses: Anchorite Labs LLC (Washington State, registered, listed delinquent/inactive); Anchorite Foundation (US non-profit for AI/robotics education). No active AI company. Associations: Monastic, reclusive connotation; may read as obscure or antisocial.
Round-1 critiques (run A1, harshest first): Reclusive monastic image odd for enterprise sales | Walled-in capability fits; monastic, obscure, antisocial feel and no .com limit. | Memorable containment metaphor, but reclusive monastic associations may feel inhospitable. | Walled-cell containment fit; distinctive; obscure; no .com domain. | Anchorite = walled cell, wry and profound; all domains free; reclusive/monastic connotation limits appeal. | Reclusive connotation; obscure; no .com. | Interesting, but potentially too reclusive/obscure. | Sharp, wry metaphor for strict confinement; clear registry and domains.

### Vallum Labs (C31) — proposed by nemotron-ultra
Pitch: The Roman frontier system: ramparts, ditches, and controlled gates enforcing sovereign boundaries—architecture of distrust made imperial infrastructure.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 6.45
Research: Companies House clear; free domains vallumlabs.co.uk, vallumlabs.ai, vallum-labs.com, vallum-labs.co.uk; meaning: Latin "vallum": a rampart or palisade, as in the earthwork beside Hadrian's Wall. Existing uses: Vallum (vallum.ai), an enterprise AI-governance and security platform founded by Stanford/Princeton researchers; Vallum (GitHub), an open-source security proxy for AI coding agents; Vallum Associates, UK tech recruitment; Vallum Software, network management. Associations: Crowded in the adjacent AI-security space.
Round-1 critiques (run A1, harshest first): Vallum.ai is direct governance rival; Hadrian's-Wall adjacent crowded. | Strong imagery but crowded by Vallum.ai competitor | Compelling Roman fortification theme, but heavily crowded by existing vallum.ai. | Roman frontier fit; strong gravitas; direct Vallum AI-governance clash. | Roman frontier fits; adjacent Vallum AI security projects crowd, domains lack .com. | Good fit, but direct clash with Vallum.ai. | Vallum = Roman frontier, exceptional architectural fit; all domains free; Vallum.ai competitor active.

### Vouchsafe Labs (C14) — proposed by gpt-5.6-luna
Pitch: A deliberately old-fashioned promise of permission and protection, capturing governed AI that earns trust rather than assuming it.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 6.39
Research: Companies House clear; free domains vouchsafelabs.com, vouchsafelabs.co.uk, vouchsafelabs.ai, vouchsafelabs.io; meaning: Archaic verb "to vouchsafe": to grant or give something graciously or condescendingly, not "safely vouch for". Existing uses: Vouchsafe (vouchsafe.id), UK biometric identity-verification startup, £1m pre-seed 2025; Vouched (vouched.id), US AI identity verification, $17M Series A; open-source "Vouchsafe" identity token standard. Associations: Old-fashioned and formal; a bit hard to say quickly.
Round-1 critiques (run A1, harshest first): Condescending archaic definition and direct clash with UK startup Vouchsafe. | Clashes with existing Vouchsafe identity-verification startup | Permission promise fit; archaic, hard to say; identity startup clash. | Permission promise fits; old-fashioned, identity startup clash, and multisyllable ease issues. | Archaic tone; clash with Vouchsafe identity firm. | Archaic; identity-startup clash; hard to pronounce. | Archaic 'permission granted' tone fits well; vouchsafe.id overlap. | Archaic charm fits gravitas; clear meaning; all domains free; Vouchsafe.id exists but not competitor.

### Seneschal (C17) — proposed by claude-sonnet-5
Pitch: A seneschal held a lord's keys but never his throne—our agents act only with delegated, revocable authority.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 6.12
Research: Companies House clear; free domains none; meaning: The chief steward of a medieval royal or noble household, overseeing administration and justice. Existing uses: Seneschal Incorporated / Seneschal Consulting, small US management/IT consultancies; Seneschal Voicebot, a small open-source AI voice-agent project; no major AI/security firm. Associations: Obscure, archaic; commonly mispronounced.
Round-1 critiques (run A1, harshest first): Hard to pronounce, no primary domains, and lacks modern enterprise punch. | Delegated authority story; no domains and obscure spelling hinder ownability and recall. | Perfect delegated-authority meaning; archaic, no usable domain. | Obscure; no domains; hard to spell. | Delegated authority fit; no domains; obscure, mispronounced, small clashes. | Excellent delegated-authority story, but obscure, difficult, and lacking available domains. | Obscure word; domains unavailable; hard to spell. | Seneschal fits delegated authority; all domains free; archaic and hard to pronounce.

### Cautia (C11) — proposed by gpt-oss-120b
Pitch: Derived from “cautious”, a concise coined word evoking measured AI trust, fitting mid‑market enterprise seriousness.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 6.02
Research: Companies House clear; free domains cautia.co.uk, cautia.io; meaning: Not a standard word; nearest roots are Latin "cautio" (a legal guarantee or bond in Roman law) and "cautus" (cautious). Existing uses: No company found with this spelling; the near-identical Cautio (Bengaluru) is an AI dashcam and fleet-safety startup with $3M seed funding. Associations: Close to "Cautio" and "caution"; pronunciation uncertain.
Round-1 critiques (run A1, harshest first): Near-identical to funded competitor Cautio | Too close to Cautio AI startup; pronunciation uncertain. | Plausible coined root but pronunciation is awkward and lacks immediate weight. | Latin root works thematically; unclear pronunciation; close to Cautio competitor. | Coined; potential confusion with dashcam startup Cautio. | Cautious trust fit; coined, pronunciation risk; Cautio nearby. | Coined; close to funded Cautio; pronunciation risk. | Compact and ownable, though pronunciation uncertainty and Cautio similarity weaken it. | Coined caution works well; near-identical Cautio and pronunciation risk limit ownability.

### Redoubt (C18) — proposed by gpt-5.6-luna
Pitch: A fortified refuge with clear defensive boundaries, evoking agents contained by design and consequential actions held behind approval.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 5.96
Research: Companies House clear; free domains none; meaning: A small enclosed defensive fortification or place of retreat, often outside a larger fort. Existing uses: Redoubt (redoubt.dk), small Copenhagen cybersecurity/backup startup for Shopify stores; Redoubt Networks / Redoubt Solutions, small US IT firms; an open-source RISC-V security OS project. Associations: "American Redoubt" is a survivalist, far-right-associated relocation movement in the US north-west.
Round-1 critiques (run A1, harshest first): Survivalist political baggage; poor domain availability | Missing key domains; fraught survivalist connotations undermine enterprise trust. | American Redoubt survivalist movement association; no domain. | No domains; survivalist association; small security startups. | Fortification story fits, but no domains and far-right American Redoubt association hurt. | Fortified refuge fit; no domains; survivalist and cybersecurity clashes. | Great fit, but survivalist associations are risky. | Redoubt = defensive boundaries; all domains free; obscure word; US far-right association weak but

### VeritasGate Labs (C20) — proposed by gpt-oss-120b
Pitch: Latin for truth gate, signalling controlled AI flow and human‑approved decisions, a sober, weighty brand.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 5.62
Research: Companies House clear; free domains veritasgatelabs.com, veritasgatelabs.co.uk, veritasgatelabs.ai, veritasgatelabs.io; meaning: Invented compound of Latin veritas (truth) and "gate". Existing uses: Veritas Technologies, a large, well-known enterprise data-backup/protection company; Veritas Labs Inc., US healthcare AI/staffing; several "Veritas Lab" DNA and drug-testing labs. Associations: "Veritas" is heavily used in enterprise software, mottos, law and forensic testing; "-gate" also suggests scandal.
Round-1 critiques (run A1, harshest first): Clunky mashup evoking Veritas Technologies backup software and political scandals. | Veritas heavily used across enterprise and forensic software | Controlled flow idea, but Veritas overused and '-gate' suggests scandal. | Truth-gate fit; Veritas crowded, scandal suffix, generic compound. | Veritas is generic; -gate suggests scandal. | Veritas overused in enterprise; -gate suggests scandal; compound feels forced; domains free. | Controlled-flow idea works, but Veritas is crowded and '-gate' suggests scandal. | Veritas Technologies clash dominant; '-gate' suggests scandal. | 'Veritas' crowded; '-gate' scandal risk.

### Hadrian Labs (C04) — proposed by gemma-4-31b
Pitch: Evokes the Roman boundary wall, signaling strict limits and a controlled architecture of distrust.
Wins 0/15; finals 0; best round reached 2; mean round-1 score 5.57
Research: Companies House blocked; free domains hadrianlabs.co.uk, hadrianlabs.ai, hadrian-labs.com, hadrian-labs.co.uk; meaning: Named for Hadrian, Roman emperor (117-138 AD), best known for Hadrian's Wall across northern Britain. Existing uses: Hadrian (hadrian.io), an Amsterdam-founded (2021) agentic-AI offensive-security and attack-surface-management platform, recognised by Gartner and GigaOm, well funded and an active competitor in AI security. Associations: Hadrian's Wall (a barrier) and Roman imperial conquest; close overlap with the security company above.
Round-1 critiques (run A1, harshest first): Hadrian.io is well-funded AI security rival; CH blocked. | Blocked; direct competitor in AI security. | Blocked; direct competitor Hadrian.io in AI security | Excellent boundary metaphor, fatally compromised by a direct AI-security competitor. | Directly blocked by active Hadrian Labs Ltd and funded hadrian.io. | Blocked; direct competitor Hadrian.io occupies space; wall metaphor works. | Roman wall story strong; blocked Hadrian Labs and Hadrian.io security competitor clash. | Boundary wall fit; strong gravitas; blocked and active AI-security competitor.

### Cordon (C01) — proposed by claude-sonnet-5
Pitch: A cordon lets movement through only at sanctioned points—AI actions cross only when a human waves them on.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 5.43
Research: Companies House blocked; free domains none; meaning: A cordon is a protective line of guards or barriers enclosing an area, from French "cordon" (cord/ribbon). Existing uses: Cordon (by Codezero), a 2026 free tool securing credentials across AI coding agents; Cordon AI (cordon-ai.com), an AI-native multi-model security validation platform; a separate "Cordon" security proxy enforcing policy/audit for AI agent-to-MCP tool calls; CORDONIQ (video conferencing security). Associations: "Cordon sanitaire": a barrier against disease or a political metaphor for isolating a party; mildly exclusionary connotation.
Round-1 critiques (run A1, harshest first): Blocked at Companies House; crowded namespace; exclusionary connotation. | Blocked at Companies House; domains taken; crowded AI security space. | Strong gate metaphor; blocked name, no domains, crowded AI security. | Blocked at Companies House with multiple direct AI security clashes. | Strong control metaphor, but blocked registration and crowded security usage. | Multiple existing Cordon AI firms compete; CH blocked. | Blocked at Companies House; AI competitors exist. | Sanctioned point story; blocked, no domains, and multiple Cordon security tools clash.

### Chancery (C21) — proposed by claude-sonnet-5
Pitch: Like a chancery court, every sensitive action is sealed, recorded, and released only once duly authorised.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 5.29
Research: Companies House blocked; free domains none; meaning: The office or court of the Lord Chancellor; historically England's court of equity. Existing uses: Chancery AI Limited (chancery.ai), UK legal-AI startup for law firms, incorporated January 2026; Chancery Software, US education administration software; an open-source "Chancery" AI-agent knowledge-base project. Associations: "In chancery" means trapped in a hopeless position; evokes slow Victorian litigation (Bleak House).
Round-1 critiques (run A1, harshest first): Approval and legal process fit, but blocked amid direct legal-AI and software overlaps. | Companies House blocked and directly conflicts with new Chancery AI startup. | Blocked; legal-AI startup; negative idiom. | Authorised sealing fit; blocked, no domains; Chancery AI legal clash. | Blocked; Chancery.ai UK legal startup direct overlap; 'in chancery' = trapped, negative. | Legal authorization story; blocked, no domains, and Chancery AI clash kill ownability. | Chancery.ai UK legal-AI rival; CH blocked, slow-litigation echoes. | Blocked; clash with Chancery.ai legal startup.

### Sovereign Air (C09) — proposed by gemini-3.8-flash
Pitch: Evoking 'air gaps' and supreme authority, it signals absolute operational boundaries, strict oversight, and elite British enterprise gravitas.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 5.22
Research: Companies House clear; free domains sovereignair.co.uk, sovereignair.ai, sovereignair.io, sovereign-air.co.uk; meaning: "Sovereign": supreme, independent authority (cf. data sovereignty); "air": atmosphere or aviation. The proposer's "air gap" link is not a standard usage. Existing uses: Sovereign Air LLC, an Orlando private-jet charter operator; Cessna Citation Sovereign business jet; Sovereign Aerospace, a US aircraft company. Associations: Reads as private aviation rather than technology; "sovereign" is heavily used in fintech/govtech.
Round-1 critiques (run A1, harshest first): Reads as private aviation firm; 'air gap' link forced. | Reads as private aviation, weak thematic fit | Sovereign authority idea, but reads as private aviation, not controlled flow. | Prestigious but reads primarily as private aviation, not governed enterprise AI. | Air-gap link weak; reads aviation; sovereign fintech clutter. | Reads as private aviation, not AI security. | Reads as aviation; 'sovereign' overused in govtech. | Air-gap claim non-standard; reads as aviation; sovereign sprawls across fintech.

### AegisVector (C06) — proposed by gpt-oss-120b
Pitch: Aegis implies protection, vector signals directionality; together they convey AI that moves only where authorised.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 5.20
Research: Companies House clear; free domains aegisvector.ai, aegisvector.io; meaning: "Aegis" (the protective shield of Zeus/Athena; protection, sponsorship) plus "vector" (direction, carrier; also "attack vector"). Existing uses: "Project Aegis Vector", a niche GitHub testbed for LLM/RAG vulnerabilities (not a company); otherwise shares the crowded Aegis namespace. Associations: "Attack vector" is security jargon; the compound can read as a generic, machine-generated brand.
Round-1 critiques (run A1, harshest first): Cliché compound that sounds like generic, machine-generated cyber security jargon. | Authorization vector idea but generic, shares crowded Aegis namespace, limited domains. | Protection direction fit; shares Aegis clutter; generic machine compound. | Crowded Aegis space; sounds machine-generated; partial domains. | Generic compound in crowded aegis namespace | Aegis crowding dilutes fit; compound feels machine-generated; domains available. | Directional control is plausible, but inherits Aegis crowding and generic security language. | Aegis is a security cliché; feels generated. | Crowded 'Aegis' space; generic compound; domains free.

### Barbican (C28) — proposed by minimax-m3
Pitch: A medieval fortress guarding the gates — fitting for a firm channelling AI capability and data only where they should flow.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 5.15
Research: Companies House blocked; free domains none; meaning: A fortified gateway or outer tower guarding the entrance to a castle or walled city. Existing uses: Barbican Centre, London, Europe's largest multi-arts venue (large well-known brand); Barbican, an AI-driven SIEM/SOAR security startup; the Barbican Estate, London. Associations: Dominated by London's Barbican Centre and Estate.
Round-1 critiques (run A1, harshest first): Blocked; dominated by Barbican Centre; security startup exists. | Dominated by famous London Barbican Centre brand | Fortified gate fits; blocked, no domains, dominated by Barbican Centre brand. | Strong gatekeeping image, overwhelmed by the London Barbican and blocked registration. | Blocked in UK; universally dominated by the London arts centre. | Fortress gate fit; blocked, no domains, London arts and SIEM clash. | Barbican = fortress gate, strong fit; blocked; no domains free; Barbican Centre London dominates. | Blocked; dominated by London's Barbican Centre.

### Corbel (C13) — proposed by gemini-3.8-flash
Pitch: An architectural stone bracket supporting massive weight only through structural restraint, embodying an unyielding, deliberate architecture of distrust.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 4.92
Research: Companies House blocked; free domains none; meaning: An architectural bracket projecting from a wall to bear weight, from Old French for "crow". Existing uses: Corbel (corbelpay.com), AI CPQ/sales platform, $6.7M seed 2026; Corbel AI (usecorbel.tech), stops AI coding agents from breaking production; Corbel Ops, AI operations consulting. Associations: Corbel is also a well-known Microsoft typeface shipped with Windows and Office since 2004.
Round-1 critiques (run A1, harshest first): Microsoft typeface name; multiple Corbel AI firms; CH blocked. | Blocked; Microsoft font and startup clashes | Restraint bracket fit; blocked, no domains; Microsoft typeface and AI clashes. | Good structural metaphor, but blocked and crowded by several AI software companies. | Blocked; multiple AI startups; also a font. | Structural restraint apt; blocked, no domains, multiple AI Corbel uses, typeface clash. | Strong architectural fit; blocked; no free domains; overlaps Microsoft Corbel typeface. | Blocked at Companies House; Corbel AI exists.

### Auctra (C19) — proposed by gpt-5.6-luna
Pitch: A coined blend of authority and strata, suggesting carefully layered powers, controls, and accountability for enterprise AI.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 4.49
Research: Companies House blocked; free domains none; meaning: Not a dictionary word; an invented name echoing Latin auctor/auctoritas (author, authority) or "auction". Existing uses: Auctra (auctra.io), real-time spend authorisation for AI agents, closely matching this thesis; Auctra (auctralabs.ai), AI-agent governance layer; Auctra (getauctra.com), AI content verification; Auctra.ai, AI lead qualification for insurance. Associations: Used by at least three AI startups; easily misheard as "auction".
Round-1 critiques (run A1, harshest first): Layered control idea; blocked, no domains, multiple AI startups already use Auctra. | Blocked; multiple AI startups; sounds like auction. | Blocked on Companies House with multiple existing AI-agent startups already named Auctra. | Three AI startups already use this spelling; CH blocked. | Blocked; multiple AI-agent governance startups already use it | Layered authority idea; blocked company, no domains, three AI clashes. | Blocked; three active Auctra competitors; easily misheard as 'auction'; crowded. | Blocked; already used by multiple AI startups.

### Gnomon (C02) — proposed by gemma-4-31b
Pitch: An architectural term for precision and oversight, offering the sobriety and weight required for enterprise buyers.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 4.47
Research: Companies House blocked; free domains none; meaning: A gnomon is the raised part of a sundial that casts the shadow indicating time (also an L-shaped figure in geometry). Existing uses: Gnomon School of Visual Effects, a well-known VFX/games college in North Hollywood; Gnomon Digital, an AI/MLOps consultancy with clients incl. Société Générale and AXA; open-source "Gnomon" guardrails tool for AI coding agents; Gnomon-MCP, a maths/date tool for AI models. Associations: The sundial meaning is obscure to most; overlaps with an established, unrelated VFX education brand.
Round-1 critiques (run A1, harshest first): Precision metaphor weak fit; blocked, no domains, existing Gnomon Digital/education brand confusion. | Blocked; obscure meaning; overlaps with VFX education brand. | Obscure sundial meaning; CH blocked, all domains taken. | Sundial metaphor is obscure; blocked in UK and conflicts with VFX school. | Blocked; obscure; clashes with VFX school. | Intelligent architectural reference, undermined by registration, domains, and existing overlaps. | Blocked; clashes with known VFX school brand | Precision oversight fit; blocked; Gnomon AI and VFX clashes.

### Certes (C03) — proposed by claude-haiku-4.5
Pitch: Medieval certainty; archaic gravitas suggesting verified, trustworthy AI action under human sanction.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 4.45
Research: Companies House blocked; free domains none; meaning: Archaic English adverb meaning "certainly, in truth", from Old French, ultimately Latin "certus". Existing uses: Certes Networks, a Pittsburgh network-encryption/data-protection company (founded 2000) serving US federal and defence agencies, rebranded as Certes.ai for cybersecurity and data protection. Associations: Archaic word largely unknown in modern English; risk of mispronunciation or being read as a coined word.
Round-1 critiques (run A1, harshest first): Certainty under sanction fit; blocked; Certes.ai security clash. | Gravitas is credible, but blocked and already associated with cybersecurity. | Archaic word blocked at Companies House; direct conflict with Certes.ai. | Certes.ai rebranded crypto/data firm; CH blocked. | Blocked; clashes with existing Certes Networks security firm | Archaic certainty is apt but blocked, no domains, and Certes.ai cybersecurity exists. | Blocked; existing cybersecurity brand; archaic. | Blocked at Companies House; existing Certes.ai.

### Billet Labs (C05) — proposed by gemini-3.8-flash
Pitch: Military quarters assigned strictly by warrant, capturing constrained agency, compartmentalized access, and disciplined, no-nonsense UK engineering.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 4.41
Research: Companies House blocked; free domains billetlabs.ai, billetlabs.io, billet-labs.com, billet-labs.co.uk; meaning: A billet is lodging assigned to a soldier, or a bar of metal ("machined from billet"); the latter is the common current usage. Existing uses: Billet Labs (billetlabs.com), an existing London company (founded 2022, Companies House 14310095) making CNC-machined PC-cooling hardware; a direct UK name clash in a different industry. Associations: "Billet" is everyday jargon in machining, car tuning and PC modding, so the name reads as hardware.
Round-1 critiques (run A1, harshest first): Direct London CNC-hardware name clash; CH blocked. | Billet reads as hardware; blocked exact UK company and only limited domains. | Blocked by identical UK hardware company | Blocked; existing hardware company direct clash in UK; misreads as machining. | Blocked; hardware company clash; reads as hardware. | Disciplined tone, but blocked and directly clashes with a UK hardware company. | Assigned quarters fit; blocked; existing London hardware company. | Blocked at Companies House; hardware name clash.

### Aegis (C08) — proposed by claude-haiku-4.5
Pitch: Classical shield; connotes protection through careful permission-gating and bounded agent autonomy.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 3.96
Research: Companies House blocked; free domains none; meaning: In Greek myth the aegis is the protective shield of Zeus or Athena; hence "under the aegis of". Existing uses: Lockheed Martin Aegis Combat System (major US Navy missile-defence brand); AegisAI (aegisai.ai), agentic email-security startup by ex-Google security leads, $36M raised in 2026; Aegis Defence Services, a British private military/security company; many other security products. Associations: Extremely crowded in security and defence branding; strong military association.
Round-1 critiques (run A1, harshest first): Classical shield but hopelessly crowded; blocked, no domains, huge security clashes. | Blocked; extremely crowded security brand. | Blocked; saturated, huge existing defence brands | Shield protection fit; blocked, no domains, extremely crowded defence. | Recognisable protection signal, but exceptionally crowded and unavailable in the relevant namespace. | The ultimate security cliché; completely unownable and legally blocked. | Lockheed Aegis brand saturates; CH blocked, no domains. | Blocked; heavily saturated in defense/security.

### Sentinel (C10) — proposed by claude-haiku-4.5
Pitch: Watchful guardian; evokes controlled oversight and the architecture of distrust at your core.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 3.85
Research: Companies House at risk; free domains none; meaning: A sentinel is a soldier or guard stationed to keep watch. Existing uses: Microsoft Sentinel (major cloud SIEM, Gartner Leader); SentinelOne (large listed AI-driven cybersecurity company, 10,000+ customers); Thales Sentinel licensing/DRM products; many further security tools. Associations: Extremely overused in security software; also the robot villains in Marvel's X-Men.
Round-1 critiques (run A1, harshest first): Extremely overused in security; at risk, no domains, Microsoft and SentinelOne dominate. | Watchful oversight fit; extremely overused, blocked, no domains. | Clear oversight meaning, but overwhelmingly crowded among major security brands. | Overused in security; major incumbents; domains gone. | Massive enterprise clashes with SentinelOne and Microsoft Sentinel make it unusable. | Massively overused; no domains available | SentinelOne and Microsoft Sentinel dominate; CH at risk. | Extremely overused; major clashes with Microsoft/SentinelOne.

### NovaPulse AI Solutions (C07) — proposed by nobody (planted control)
Pitch: A modern, innovative name that conveys energy and cutting-edge AI solutions for business.
Wins 0/15; finals 0; best round reached 1; mean round-1 score 2.16
Research: Companies House not checked; free domains none; meaning: A generic compound of "nova" and "pulse" with no specific meaning. Existing uses: Many small firms: Novapulse AI (business intelligence), NovaPulse Labs (cloud engineering), Nova Pulse LLC (SMS marketing), NovaPulse Solutions (SEO), NovaPulse Care (AI voicemail), Novapulse Dynamics (AI content). Associations: Saturated naming pattern; very low distinctiveness.
Round-1 critiques (run A1, harshest first): Generic compound; saturated, unusable domains, low distinctiveness, no story. | Entirely generic agency template name with dozens of identical small competitors. | Generic AI-solutions name; no domains; saturated, forgettable. | Generic; no domains; saturated naming. | Generic, saturated AI-name pattern, no distinctiveness | Generic, saturated, and unavailable across domains; offers little governance meaning. | Generic AI naming pattern; zero distinctiveness. | Generic, saturated nova/pulse pattern; thin distinctiveness. | Generic pattern oversaturated; no thematic fit; entirely forgettable; no gravitas.

## Final-round critiques and advocates' cases (sample runs)

- A1 final, Countermand Labs: critiques: Sharp override metaphor, sober military tone, clean registry | Strong command‑and‑control metaphor; may feel militaristic to some. | Perfect fit: human veto over risky actions. Military precision earns gravitas. Memorable, ownable. Slight:; case: Military tone is disciplined control, not aggression: Countermand Labs names the human veto CISOs demand over risky AI. Clean registry, domains, sober, ownable.
- A1 final, Claustra Labs: critiques: Elegant containment idea, claustrophobia risk undercuts trust | Beautiful containment metaphor; claustrophobia root and Latin pronunciation dilute polish. | Elegant containment image; Latin root risks subtle negative connotations.; case: Claustra reframes containment as engineering, not confinement: barred gates, not padlocked cells. CISOs buy control, not comfort—claustrophobia signals the product working exactly as intended.
- B3 final, Countermand Labs: critiques: Precise veto metaphor, strong human-control narrative, slight aggression risk | Precise veto thesis; military tone acceptable; memorable; IP clear. | Decisive human veto authority delivers unmatched gravitas for regulated enterprise buyers.; case: Countermand nails the core thesis: humans revoke risky actions before they execute. Clean IP, four free domains, no confusable competitors—precisely the sober, veto-first signal a CISO trusts instantly.
- B3 final, Claustra Labs: critiques: Elegant barrier metaphor; claustrophobia association and hard pronunciation undermine CISO accessibility. | Elegant lock metaphor, but claustrophobia/pronunciation risk | Elegant gate metaphor; claustrophobia and pronunciation risk need explanation for buyers.; case: Claustra evokes the precision of bolted gates. The claustrophobia nuance is an asset for CISOs: in regulated AI, tight boundaries aren't restrictive—they are the essential safety mechanism.
- C1 final, Claustra Labs: critiques: Captures containment well; misses capability-granting and approval nuance | Elegant gating metaphor signals controlled access; claustrophobia root may dampen recall. | Elegant gating metaphor, but obscure and claustrophobic root.; case: Rather than causing unease, the enclosure root perfectly signals strict enterprise boundaries to CISOs. It offers rare Latin gravitas, complete sector exclusivity, and clean domains across every relevant extension.
- C1 final, Countermand Labs: critiques: Strong veto imagery; military tone risks alienating civilian buyers | Precise human veto metaphor; military tone may limit sector appeal. | Precise veto mechanic; military tone aids control signaling.; case: Countermand Labs names exactly what CISOs need: a clean, auditable human veto over agent actions. Military precision signals control, not aggression—reassuring in regulated sectors, not alarming.
- C3 final, Claustra Labs: critiques: Latin gravitas, elegant gating; claustrophobia echo risks anxiety. | Latin origin adds gravitas but may be opaque; distinct yet slightly abstract. | Elegant metaphor, but meaning needs explaining to buyers; case: Latin 'claustra' is the root of 'cloister' and 'claustrophobia'—buyers feel it without parsing. Bars and locks ARE the gated-capability architecture. To a CISO, sober Latin signals gravitas, not opacity.
- C3 final, Countermand Labs: critiques: Military tone may deter some regulated buyers; fits command metaphor well. | Vivid human-veto story, military tone risks tone mismatch | Direct human veto; military tone may alienate; nearby Counter Labs confusion.; case: Countermand Labs names the human veto, not combat. Its command register reassures regulated buyers: risky AI halts on one explicit contrary order.