#!/usr/bin/env python3
"""Find Jev's favourite name: a generator proposes 100 names, Jev scores each on five criteria, and
the generator, shown the scores, tries to beat them. Five rounds.

  python3 jev_quest.py --rounds 5 --per-round 100

The generator is Claude Sonnet 5 with extended thinking disabled. Jev is TypeSafe's decision model
via OpenRouter; it sees only the brief and the name, so it cannot judge availability. The top names
are screened with namecheck.py afterwards.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import re
import statistics
import sys
import urllib.request
from pathlib import Path

sys.argv, _argv = sys.argv[:1], sys.argv
import league  # noqa: E402
from league import ENV, JUDGE_BRIEF, Ledger, ask_jev, norm, parse_json  # noqa: E402
sys.argv = _argv

HERE = Path(__file__).resolve().parent
OUT = HERE / "results" / "jev-quest"
GENERATOR = "anthropic/claude-sonnet-5"

CRITERIA = {
    "fit": ("Does the name evoke the thesis: agents act only with granted capability, risky actions wait for human approval, information flows only where it may?",
            ["No connection to the thesis.", "A loose or generic connection.", "Clearly suggests control, permission or approval.",
             "Tells the whole story: granted capability, human approval and controlled flow."]),
    "gravitas": ("Would a CFO or CISO at a regulated UK firm trust a company with this name?",
                 ["Silly, cheap or off-putting.", "Neutral.", "Sober and credible.", "Commands trust, like Palantir or Thought Machine."]),
    "distinct": ("Is the name distinctive and memorable after one hearing, and free of shield/guard/sentinel clichés?",
                 ["Generic or cliched; forgotten at once.", "Somewhat memorable.", "Memorable and fresh.", "Striking and ownable in the mind."]),
    "ease": ("Is the name easy to say, spell and type after hearing it once?",
             ["Hard to say or spell; people would get it wrong.", "Some would stumble.", "Easy for most people.", "Effortless to say and spell."]),
    "wit": ("Is the name a little wry or clever without being silly?",
            ["Flat, or silly and gimmicky.", "Plain; no wit.", "A quiet, knowing touch.", "Genuinely wry and clever while staying serious."]),
}


def generate(prompt: str, ledger: Ledger) -> list[str]:
    body = {"model": GENERATOR, "max_tokens": 6000, "thinking": {"type": "disabled"},
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(ENV["LITELLM_PROXY_API_BASE"] + "/v1/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": "Bearer " + ENV["LITELLM_PROXY_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.load(r)
        cost = float(r.headers.get("x-litellm-response-cost") or 0)
    text = data["choices"][0]["message"].get("content") or ""
    ledger.add({"stage": "generate", "model": "sonnet-5-nothink", "ok": True, "cost": cost,
                "completion_tokens": (data.get("usage") or {}).get("completion_tokens"), "text": text})
    names = (parse_json(text) or {}).get("names") or []
    return [re.sub(r"\s+", " ", str(n)).strip() for n in names if re.search(r"[A-Za-z]{3}", str(n))]


def score(names: list[str], ledger: Ledger, rnd: int) -> dict[str, dict[str, float]]:
    """Jev scores each name on each criterion; state holds the brief and just that batch of names."""
    ids = {f"N{i:03d}": n for i, n in enumerate(names)}
    items = [(nid, k) for nid in ids for k in CRITERIA]
    chunks = [items[i:i + 32] for i in range(0, len(items), 32)]

    def run(chunk):
        state = {"brief": JUDGE_BRIEF, "names": {nid: ids[nid] for nid in {n for n, _ in chunk}}}
        qs = {f"{nid}_{k}": {"type": "score", "criteria": CRITERIA[k][1],
                             "instructions": f'The candidate company name "{ids[nid]}" ({nid}). {CRITERIA[k][0]}'}
              for nid, k in chunk}
        return ask_jev(state, qs, ledger, f"r{rnd}-jev")
    with cf.ThreadPoolExecutor(6) as ex:
        answers = {}
        for a in ex.map(run, chunks):
            answers.update(a)
    out = {}
    for nid, name in ids.items():
        parts = {}
        for k, (_, levels) in CRITERIA.items():
            a = answers.get(f"{nid}_{k}") or {}
            if isinstance(a.get("score"), (int, float)):
                parts[k] = 1 + 9 * a["score"] / (len(levels) - 1)
        if len(parts) == len(CRITERIA):
            parts["total"] = statistics.mean(parts[k] for k in CRITERIA)
            out[name] = parts
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--per-round", type=int, default=100)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(OUT / "calls.jsonl")
    league.BUDGET_USD_PER_RUN = 2.0
    seen: dict[str, dict] = {}
    rounds = []
    crit_text = "\n".join(f"- {k}: {q}" for k, (q, _) in CRITERIA.items())
    for rnd in range(1, args.rounds + 1):
        if rnd == 1:
            prompt = f"""{JUDGE_BRIEF}

Propose {args.per_round} different candidate names for this company. Vary the styles: coined words,
literary and historical borrowings, short phrases, plain words with a suffix. Reply with JSON only:
{{"names": ["...", ...]}}"""
        else:
            ranked = sorted(seen.items(), key=lambda kv: -kv[1]["total"])
            top = "\n".join(f'{n}: total {s["total"]:.2f} (' + ", ".join(f"{k} {s[k]:.1f}" for k in CRITERIA) + ")" for n, s in ranked[:25])
            low = "\n".join(f'{n}: total {s["total"]:.2f}' for n, s in ranked[-10:])
            prompt = f"""{JUDGE_BRIEF}

A judge scores every name from 1 to 10 on five criteria and averages them:
{crit_text}

Its best-scoring names so far:
{top}

Its lowest:
{low}

Propose {args.per_round} NEW names (not in the lists above) that you expect to score higher than the
current best. Learn from what the judge rewards, but keep every name usable for a real company.
Reply with JSON only: {{"names": ["...", ...]}}"""
        names = [n for n in dict.fromkeys(generate(prompt, ledger)) if norm(n) not in {norm(x) for x in seen}]
        scores = score(names[: args.per_round], ledger, rnd)
        for n, s in scores.items():
            seen[n] = {**s, "round": rnd}
        totals = [s["total"] for s in scores.values()]
        best = max(scores.items(), key=lambda kv: kv[1]["total"])
        rounds.append({"round": rnd, "n": len(scores), "mean": statistics.mean(totals), "max": max(totals),
                       "p90": sorted(totals)[int(0.9 * len(totals))], "best": best[0], "cost_so_far": ledger.cost})
        print(f"round {rnd}: {len(scores)} names, mean {statistics.mean(totals):.2f}, max {max(totals):.2f} "
              f"({best[0]}), ${ledger.cost:.3f}", flush=True)
    ranked = sorted(seen.items(), key=lambda kv: -kv[1]["total"])
    (OUT / "results.json").write_text(json.dumps({"rounds": rounds, "names": dict(ranked), "cost": ledger.cost}, indent=1))
    (OUT / "top.txt").write_text("\n".join(n for n, _ in ranked[:15]) + "\n")
    print("top 15:")
    for n, s in ranked[:15]:
        print(f"  {n:28} {s['total']:.2f} r{s['round']}  " + " ".join(f"{k}={s[k]:.1f}" for k in CRITERIA))


if __name__ == "__main__":
    main()
