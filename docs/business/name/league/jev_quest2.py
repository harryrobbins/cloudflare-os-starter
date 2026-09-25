#!/usr/bin/env python3
"""Jev's favourite name, take two: pairwise judging and style-diverse generation.

Each round Claude Sonnet 5 (thinking on) writes 10 names in each of 10 fixed styles. Jev answers one
question per pair, "is A a better company name than B?", in both orders. Every new name meets six
opponents drawn from the current top names and fixed anchors, and the top names play each other.
A Bradley–Terry fit over all comparisons so far ranks every name ever seen. The anchors stay in every
round, so improvement is measured against a fixed yardstick: the probability of beating Countermand.

  python3 jev_quest2.py --rounds 5
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import itertools
import json
import math
import random
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
OUT = HERE / "results" / "jev-quest2"
GENERATOR = "anthropic/claude-sonnet-5"
ANCHORS = ["Countermand", "Countermand Labs", "Claustra Labs", "Franklin Gate"]
YARDSTICK = "Countermand"
STYLES = [
    "coined words (invented, pronounceable, with a meaningful root)",
    "Latin or Greek borrowings",
    "Old or Middle English words and archaic crafts",
    "British legal, constitutional or parliamentary terms",
    "engineering, hydraulic or mechanical parts that meter or restrain",
    "short understated phrases in the style of Iain M. Banks ship names",
    "plain English verbs or nouns with a suffix such as Labs or Works",
    "places, people or events from British history",
    "nautical and navigation terms",
    "heraldry, guild and craft vocabulary",
]
OPPONENTS = 6


def generate(prompt: str, ledger: Ledger) -> dict[str, list[str]]:
    body = {"model": GENERATOR, "max_tokens": 16000, "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(ENV["LITELLM_PROXY_API_BASE"] + "/v1/chat/completions", json.dumps(body).encode(),
                                 {"Authorization": "Bearer " + ENV["LITELLM_PROXY_API_KEY"], "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.load(r)
        cost = float(r.headers.get("x-litellm-response-cost") or 0)
    text = data["choices"][0]["message"].get("content") or ""
    ledger.add({"stage": "generate", "model": "sonnet-5", "ok": True, "cost": cost,
                "completion_tokens": (data.get("usage") or {}).get("completion_tokens"), "text": text})
    styles = (parse_json(text) or {}).get("styles") or {}
    return {str(k): [re.sub(r"\s+", " ", str(n)).strip() for n in v if re.search(r"[A-Za-z]{3}", str(n))]
            for k, v in styles.items() if isinstance(v, list)}


def judge_pairs(pairs: list[tuple[str, str]], ledger: Ledger, stage: str) -> list[tuple[str, str, float]]:
    """P(first is better) for each ordered pair, from Jev, 32 questions per request."""
    chunks = [pairs[i:i + 32] for i in range(0, len(pairs), 32)]

    def run(chunk):
        qs = {f"q{i}": {"type": "noul",
                        "instructions": f'Is name A, "{a}", a better company name for this brief than name B, "{b}"?',
                        "criteria": {"true": f'"{a}" is the better name.', "false": f'"{b}" is the better name.'}}
              for i, (a, b) in enumerate(chunk)}
        try:
            ans = ask_jev({"brief": JUDGE_BRIEF}, qs, ledger, stage)
        except Exception as e:  # one failed batch should not end the round
            print("  jev batch failed:", e, flush=True)
            return []
        return [(a, b, float(ans[f"q{i}"]["noul"])) for i, (a, b) in enumerate(chunk)
                if isinstance((ans.get(f"q{i}") or {}).get("noul"), (int, float))]
    with cf.ThreadPoolExecutor(6) as ex:
        return [o for r in ex.map(run, chunks) for o in r]


def bradley_terry(obs, iters=300):
    names = sorted({x for a, b, _ in obs for x in (a, b)})
    wins = {n: 0.1 for n in names}  # small prior keeps unbeaten or winless names finite
    games: dict[str, dict[str, float]] = {n: {} for n in names}
    for a, b, p in obs:
        wins[a] += p
        wins[b] += 1 - p
        games[a][b] = games[a].get(b, 0) + 1
        games[b][a] = games[b].get(a, 0) + 1
    s = {n: 1.0 for n in names}
    for _ in range(iters):
        new = {}
        for n in names:
            den = sum(k / (s[n] + s[m]) for m, k in games[n].items()) + 0.2 / (s[n] + 1.0)
            new[n] = wins[n] / den
        g = math.exp(statistics.mean(math.log(v) for v in new.values()))
        s = {n: v / g for n, v in new.items()}
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=5)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(OUT / "calls.jsonl")
    league.BUDGET_USD_PER_RUN = 2.0
    rng = random.Random(42)
    style_of: dict[str, str] = {a: "anchor" for a in ANCHORS}
    round_of: dict[str, int] = {a: 0 for a in ANCHORS}
    obs: list[tuple[str, str, float]] = []
    # Anchors play each other first so the yardstick is fixed before round 1.
    obs += judge_pairs([p for a, b in itertools.combinations(ANCHORS, 2) for p in ((a, b), (b, a))], ledger, "anchors")
    strength = bradley_terry(obs)
    history = []
    for rnd in range(1, args.rounds + 1):
        if rnd == 1:
            feedback = ""
        else:
            ranked = sorted(strength, key=lambda n: -strength[n])
            beat = lambda n: strength[n] / (strength[n] + strength[YARDSTICK])  # noqa: E731
            top = "\n".join(f"{n} ({style_of[n]}): beats {YARDSTICK} {beat(n):.0%} of the time" for n in ranked[:15])
            per_style = []
            for st in STYLES:
                mine = [n for n in strength if style_of.get(n) == st]
                if mine:
                    best = max(mine, key=lambda n: strength[n])
                    worst = min(mine, key=lambda n: strength[n])
                    per_style.append(f"- {st}: mean {statistics.mean(beat(n) for n in mine):.0%}; best {best} ({beat(best):.0%}); worst {worst} ({beat(worst):.0%})")
            feedback = f"""
A judge compares names two at a time. The strongest names so far, with how often each would beat
"{YARDSTICK}" (the current benchmark) head to head:
{top}

How each style has done (chance of beating {YARDSTICK}):
{chr(10).join(per_style)}

Study what separates the winners from the losers within each style, then aim to beat the leaders.
Do not repeat any name above."""
        prompt = f"""{JUDGE_BRIEF}
{feedback}
Write 10 new candidate names in EACH of these 10 styles (100 in total), every one usable for a real
company. Think about what would make each genuinely better, not just similar to past winners.
Styles:
{chr(10).join(f"- {s}" for s in STYLES)}
Reply with JSON only, keyed by the style text exactly as given:
{{"styles": {{"<style>": ["name", ...], ...}}}}"""
        batches = generate(prompt, ledger)
        seen = {norm(n) for n in style_of}
        new = []
        for st, names in batches.items():
            key = next((s for s in STYLES if s[:20].lower() in st.lower() or st.lower() in s.lower()), st)
            for n in names[:10]:
                if norm(n) not in seen:
                    seen.add(norm(n))
                    style_of[n] = key
                    round_of[n] = rnd
                    new.append(n)
        # Each new name meets six opponents from the anchors and the current top 10, in both orders.
        ranked = sorted(strength, key=lambda n: -strength[n])
        pool = list(dict.fromkeys(ANCHORS + ranked[:10]))
        pairs = []
        for n in new:
            for opp in rng.sample(pool, min(OPPONENTS, len(pool))):
                pairs += [(n, opp), (opp, n)]
        obs += judge_pairs(pairs, ledger, f"r{rnd}-new")
        strength = bradley_terry(obs)
        # The new top 12 play one another, both orders, to settle the head of the table.
        top12 = sorted(strength, key=lambda n: -strength[n])[:12]
        played = {(a, b) for a, b, _ in obs}
        rematch = [(a, b) for a, b in itertools.permutations(top12, 2) if (a, b) not in played]
        obs += judge_pairs(rematch, ledger, f"r{rnd}-top")
        strength = bradley_terry(obs)
        beat = lambda n: strength[n] / (strength[n] + strength[YARDSTICK])  # noqa: E731
        fresh = sorted(new, key=lambda n: -strength[n])
        # Position bias and order consistency for this round's pairs.
        by = {}
        for a, b, p in obs:
            by.setdefault(tuple(sorted((a, b))), []).append(p if a < b else 1 - p)
        both = [v for v in by.values() if len(v) >= 2]
        flips = sum(1 for v in both if (v[0] - 0.5) * (v[1] - 0.5) < 0) / max(1, len(both))
        entry = {"round": rnd, "new": len(new), "judgements": len(obs), "cost": ledger.cost,
                 "best_new": fresh[0], "best_new_beats_yardstick": beat(fresh[0]),
                 "top10_new_mean_beats": statistics.mean(beat(n) for n in fresh[:10]),
                 "mean_new_beats": statistics.mean(beat(n) for n in new),
                 "leader": max(strength, key=lambda n: strength[n]), "flip_rate": flips,
                 "position_bias": statistics.mean(p for _, _, p in obs) - 0.5,
                 "style_mean": {st: statistics.mean(beat(n) for n in new if style_of[n] == st)
                                for st in STYLES if any(style_of[n] == st for n in new)}}
        history.append(entry)
        print(f"round {rnd}: {len(new)} new; best new {fresh[0]} beats {YARDSTICK} {beat(fresh[0]):.0%}; "
              f"top-10 new {entry['top10_new_mean_beats']:.0%}; all new {entry['mean_new_beats']:.0%}; "
              f"leader {entry['leader']}; flips {flips:.0%}; ${ledger.cost:.3f}", flush=True)
    ranked = sorted(strength, key=lambda n: -strength[n])
    beat = lambda n: strength[n] / (strength[n] + strength[YARDSTICK])  # noqa: E731
    table = [{"name": n, "style": style_of[n], "round": round_of[n], "strength": strength[n], "beats_yardstick": beat(n)}
             for n in ranked]
    (OUT / "results.json").write_text(json.dumps({"rounds": history, "table": table, "cost": ledger.cost,
                                                  "judgements": len(obs)}, indent=1))
    (OUT / "top.txt").write_text("\n".join(t["name"] for t in table[:15] if t["style"] != "anchor") + "\n")
    print("top 20:")
    for t in table[:20]:
        print(f"  {t['name']:28} beats {YARDSTICK} {t['beats_yardstick']:.0%}  r{t['round']}  {t['style'][:40]}")


if __name__ == "__main__":
    main()
