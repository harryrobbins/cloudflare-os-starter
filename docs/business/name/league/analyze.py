#!/usr/bin/env python3
"""Summarise league runs into results/summary.json (read by the report page).

Measures, per run and per variant:
  winner and how often each name wins across repeats
  herding      how far judges move towards last round's shared mean when rescoring the same name
  self-pref    a judge's blind score for its own name minus the other judges' mean for it
  agreement    mean pairwise correlation of round-1 judge totals, and the effective number of judges
  jev          correlation between Jev and the panel (variant B)
  control      the round in which the planted bland name went out
  backing      when each model first backed the eventual winner, self-backing, leader-following
"""
from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"


def pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3 or statistics.pstdev(xs) == 0 or statistics.pstdev(ys) == 0:
        return None
    return statistics.correlation(xs, ys)


def run_metrics(run: dict, cands: dict) -> dict:
    rounds = run["rounds"]
    judges = sorted({j for r in rounds for s in r["scores"].values() for j in s["by_judge"]})

    # Herding: for a name scored in consecutive rounds, compare the judge's distance from last round's
    # shared panel mean before and after seeing it.
    toward, moves = [], []
    for prev, cur in zip(rounds, rounds[1:]):
        for cid, s in cur["scores"].items():
            p = prev["scores"].get(cid)
            if not p:
                continue
            for j, e in s["by_judge"].items():
                if j in p["by_judge"]:
                    before = abs(p["by_judge"][j]["total"] - p["panel"])
                    after = abs(e["total"] - p["panel"])
                    toward.append(before - after)
                    moves.append(abs(e["total"] - p["by_judge"][j]["total"]))
    spread = [statistics.mean([statistics.pstdev([e["total"] for e in s["by_judge"].values()])
                               for s in r["scores"].values() if len(s["by_judge"]) > 1]) for r in rounds]

    # Self-preference, from the silently excluded own-name scores.
    selfp = []
    for r in rounds:
        for m in r["self_marks"]:
            others = [e["total"] for e in r["scores"][m["id"]]["by_judge"].values()]
            if others:
                selfp.append({"judge": m["judge"], "delta": m["total"] - statistics.mean(others)})

    # Agreement in round 1, and the effective number of independent judges.
    r1 = rounds[0]["scores"]
    vec = {j: {cid: s["by_judge"][j]["total"] for cid, s in r1.items() if j in s["by_judge"]} for j in judges}
    pairs = {}
    for a, b in combinations(judges, 2):
        common = sorted(set(vec[a]) & set(vec[b]))
        rho = pearson([vec[a][c] for c in common], [vec[b][c] for c in common])
        if rho is not None:
            pairs[f"{a}|{b}"] = rho
    rbar = statistics.mean(pairs.values()) if pairs else None
    # The same on names clear at Companies House only, where the dossier gives no easy answer.
    clear = {cid for cid, c in cands.items() if c.get("ch") == "clear"}
    pairs_clear = []
    for a, b in combinations(judges, 2):
        common = sorted(set(vec[a]) & set(vec[b]) & clear)
        rho = pearson([vec[a][c] for c in common], [vec[b][c] for c in common])
        if rho is not None:
            pairs_clear.append(rho)
    rbar_clear = statistics.mean(pairs_clear) if pairs_clear else None
    n = len(judges)
    n_eff = n / (1 + (n - 1) * rbar) if rbar is not None and rbar > -1 / (n - 1) else None

    # Each judge's round-1 agreement with the final order (rank of elimination), a crude "accuracy".
    out_round = {}
    for r in rounds:
        for cid in r["field"][r["keep"]:]:
            out_round[cid] = r["round"]
    out_round[run["winner"]] = len(rounds) + 1
    judge_acc = {}
    for j in judges:
        cs = [c for c in vec[j] if c in out_round]
        rho = pearson([vec[j][c] for c in cs], [out_round[c] for c in cs])
        if rho is not None:
            judge_acc[j] = rho

    # Jev against the panel, round 1.
    jev_rho = None
    if run["variant"] == "B":
        pts = [(s["panel"], s["jev"]) for s in r1.values() if s.get("jev") is not None]
        if pts:
            jev_rho = pearson([p for p, _ in pts], [q for _, q in pts])

    control = next((cid for cid, c in cands.items() if c.get("control")), None)

    # Backing behaviour.
    backing = {}
    if run["variant"] in "AB":
        leaders = [r["field"][0] for r in rounds]
        for m, picks in run["backings"].items():
            owned = {cid for cid, c in cands.items() if m in c["owners"]}
            follow = sum(1 for i, p in enumerate(picks[1:], 1) if p == leaders[i - 1])
            backing[m] = {"picks": picks, "first_correct": run["table"][m].get("first_correct_round"),
                          "self_backs": sum(1 for p in picks if p in owned),
                          "followed_leader": follow, "changes": sum(1 for a, b in zip(picks, picks[1:]) if a != b)}

    return {
        "run": run["run"], "variant": run["variant"], "winner": run["winner"],
        "winner_name": run["winner_name"], "cost": run["cost"], "calls": run["calls"],
        "rounds": len(rounds), "control_out_round": out_round.get(control),
        "herding_toward_mean": statistics.mean(toward) if toward else None,
        "mean_rescore_move": statistics.mean(moves) if moves else None,
        "spread_by_round": spread,
        "self_pref_mean": statistics.mean(d["delta"] for d in selfp) if selfp else None,
        "self_pref_by_judge": {j: statistics.mean(d["delta"] for d in selfp if d["judge"] == j)
                               for j in {d["judge"] for d in selfp}},
        "judge_corr_mean": rbar, "effective_judges": n_eff, "judge_pairs": pairs,
        "judge_corr_clear": rbar_clear,
        "effective_judges_clear": n / (1 + (n - 1) * rbar_clear) if rbar_clear is not None and rbar_clear > 0 else None,
        "judge_accuracy": judge_acc, "jev_panel_corr": jev_rho,
        "failed_ballots": sum(len(r["failed_ballots"]) for r in rounds),
        "backing": backing, "table": run["table"],
        "trajectory": [{"round": r["round"], "keep": r["keep"],
                        "scores": {cid: {"score": s["score"], "panel": s["panel"], "jev": s["jev"]}
                                   for cid, s in r["scores"].items()},
                        "critiques": r["critiques"], "cases": r["cases"], "backings": r["backings"]}
                       for r in rounds],
    }


def main() -> None:
    proposals = json.loads((RESULTS / "proposals.json").read_text())
    cands = {c["id"]: c for c in proposals["candidates"]}
    for cid, fx in json.loads((RESULTS / "dossier-facts.json").read_text()).items():
        cands[cid]["ch"] = fx["companies_house"]
    dossier = json.loads((RESULTS / "dossier.json").read_text())
    runs = [json.loads(p.read_text()) for p in sorted(RESULTS.glob("run-*.json"))]
    metrics = [run_metrics(r, cands) for r in runs]

    by_variant = defaultdict(list)
    for m in metrics:
        by_variant[m["variant"]].append(m)

    def avg(ms, key):
        vals = [m[key] for m in ms if m[key] is not None]
        return statistics.mean(vals) if vals else None

    variants = {}
    for v, ms in sorted(by_variant.items()):
        wins = Counter(m["winner"] for m in ms)
        variants[v] = {"runs": len(ms), "wins": dict(wins), "cost": sum(m["cost"] for m in ms),
                       **{k: avg(ms, k) for k in ("herding_toward_mean", "mean_rescore_move", "self_pref_mean",
                                                  "judge_corr_mean", "effective_judges", "judge_corr_clear",
                                                  "effective_judges_clear", "jev_panel_corr",
                                                  "control_out_round")}}

    # Model league across all runs: proposer + backing points, plus judging accuracy.
    models = defaultdict(lambda: {"proposer": 0, "backing": 0, "total": 0, "accuracy": [], "self_pref": []})
    for m in metrics:
        for name, row in m["table"].items():
            for k in ("proposer", "backing", "total"):
                models[name][k] += row[k]
        for name, acc in m["judge_accuracy"].items():
            models[name]["accuracy"].append(acc)
        for name, d in m["self_pref_by_judge"].items():
            models[name]["self_pref"].append(d)
    for row in models.values():
        row["accuracy"] = statistics.mean(row["accuracy"]) if row["accuracy"] else None
        row["self_pref"] = statistics.mean(row["self_pref"]) if row["self_pref"] else None

    # Model cost and token use, from the call ledgers.
    usage = defaultdict(lambda: {"cost": 0.0, "calls": 0, "failed": 0, "prompt_tokens": 0, "completion_tokens": 0})
    for path in RESULTS.glob("*.calls.jsonl"):
        for line in path.read_text().splitlines():
            row = json.loads(line)
            u = usage[row["model"]]
            u["cost"] += row.get("cost") or 0
            u["calls"] += 1
            u["failed"] += 0 if row.get("ok") and row.get("parsed", True) else 1
            u["prompt_tokens"] += row.get("prompt_tokens") or 0
            u["completion_tokens"] += row.get("completion_tokens") or 0

    summary = {"candidates": list(cands.values()), "dossier": dossier, "runs": metrics, "variants": variants,
               "models": models, "usage": usage, "total_cost": sum(u["cost"] for u in usage.values())}
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=1, default=float))
    print(f"{len(runs)} runs, total ${summary['total_cost']:.3f}")
    for v, s in variants.items():
        print(f"  {v}: wins {s['wins']}; herding {s['herding_toward_mean']}; self-pref {s['self_pref_mean']}; "
              f"n_eff {s['effective_judges']}; control out r{s['control_out_round']}; ${s['cost']:.3f}")


if __name__ == "__main__":
    main()
