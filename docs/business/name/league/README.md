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
