#!/usr/bin/env python3
"""Cheap configuration experiments for league v2: one blind panel round over the whole field.

  python3 configs.py score base persona temp persona_temp --repeats 2
  python3 configs.py finals --config persona_temp --top 6     # pairwise Bradley–Terry finals
  python3 configs.py analyze                                  # results/v2/summary.json

Configurations:
  base          the league's panel prompt, default sampling
  persona       each judge gets a different expert persona as its system prompt
  temp          each judge gets a different temperature (0.2-1.3; Claude capped at 1.0)
  persona_temp  both

The dossier is facts only: Companies House for the name as proposed and its bare form, free domains,
meaning and existing uses. No evaluative wording ("strong military connotation") reaches the judges.

Rankings computed from each round:
  mean      unweighted mean of weighted-rubric totals, own-name scores excluded
  peerrank  judges weighted by how the others rate their own proposals, iterated to a fixed point
            with damping (PageRank-style): w = (1-d)/N + d * normalise(sum_i w_i * s_i(names of j))
  borda     each judge's ranking converted to Borda points, summed
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import itertools
import json
import math
import random
import statistics
import sys
from pathlib import Path

sys.argv, _argv = sys.argv[:1], sys.argv
import league  # noqa: E402
from league import CRITERIA, JUDGE_BRIEF, MODELS, Ledger, chat, weighted  # noqa: E402
sys.argv = _argv

HERE = Path(__file__).resolve().parent
OUT = HERE / "results" / "v2"
DAMPING = 0.85

PERSONAS = [
    "You are the CFO of a UK mid-market insurer. You judge names by how they would land with your board and auditors, and whether you would sign a purchase order to a company called this.",
    "You are the CISO of a UK retail bank. You have seen every shield, guard and sentinel brand, distrust security clichés, and care whether a name signals real control over AI agents.",
    "You are a senior brand strategist at a London naming agency. You judge distinctiveness, memorability after one hearing, and the story a name can carry for ten years.",
    "You are a UK trade-mark attorney. You judge registrability, descriptiveness, likelihood of confusion with existing companies, and the risk of a costly rebrand.",
    "You are a sceptical technology journalist. You ask whether a name would be mocked in a headline, sounds like every other AI startup, or is quietly clever.",
    "You are the operations director of a UK logistics firm and a plain speaker. You judge whether you could say the name on a call without spelling it, and whether it tells you what the company does.",
    "You are a linguist. You judge pronunciation, spelling, rhythm, and unwanted meanings in English and other major languages.",
    "You are a partner at a European venture firm. You judge whether the name could carry a category-defining £100m company and survive expansion beyond the UK.",
    "You are a UK public-sector procurement lead. You judge whether the name reads as serious, trustworthy and safe to put in a tender or a ministerial briefing.",
    "You are the COO of a mid-sized professional-services firm who hates jargon. You judge clarity, warmth and whether the name sounds like people you would want to work with.",
]
TEMPS = [0.2, 1.0, 0.5, 1.3, 0.8, 1.1, 0.3, 1.2, 0.6, 0.9]
CLAUDE = {"claude-sonnet-5", "claude-haiku-4.5"}


def facts_dossier() -> dict[str, str]:
    """Facts only: registry, domains (as proposed and bare), meaning, existing uses."""
    facts = json.loads((HERE / "results/dossier-facts.json").read_text())
    bare = parse_namecheck(HERE / "results/namecheck-bare.md")
    out = {}
    for cid, fx in facts.items():
        name = fx["name"]
        frees = [d for d in fx["free_domains"] if "-" not in d][:4]
        text = f"Companies House ({name}): {fx['companies_house']}. Free domains: {', '.join(frees) or 'none of .com/.co.uk/.ai/.io'}."
        if name.endswith(" Labs"):
            b = name[:-5]
            if b in bare:
                verdict, bfree = bare[b]
                bf = [d for d in bfree if "-" not in d][:4]
                text += f" Bare name {b}: Companies House {verdict}; free domains {', '.join(bf) or 'none'}."
        text += f" Meaning: {fx['meaning']} Existing uses: {fx['clashes']}"
        out[cid] = text
    return out


def parse_namecheck(path: Path) -> dict[str, tuple[str, list[str]]]:
    if not path.exists():
        return {}
    dom, ch = {}, {}
    for line in path.read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 4 and cells[0] not in ("Name", "---"):
            dom[cells[0]] = [d for d in cells[1].split(", ") if d and d != "—"]
        if len(cells) == 5 and cells[0] not in ("Name", "---"):
            ch[cells[0]] = cells[1]
    return {n: (ch.get(n, "?"), dom.get(n, [])) for n in set(dom) | set(ch)}


def assignments(config: str, rep: int) -> dict[str, dict]:
    """Persona and temperature per judge, rotated by repeat so no model keeps one persona."""
    names = list(MODELS)
    out = {}
    for i, m in enumerate(names):
        a = {}
        if "persona" in config:
            a["persona"] = PERSONAS[(i + rep) % len(PERSONAS)]
        if "temp" in config:
            t = TEMPS[(i + 3 * rep) % len(TEMPS)]
            a["temperature"] = min(t, 1.0) if m in CLAUDE else t
        out[m] = a
    return out


def chat_with(model, prompt, max_tokens, ledger, stage, persona=None, temperature=None):
    return chat(model, prompt, max_tokens, ledger, stage, persona, temperature)


def panel_prompt(field: list[dict], dossier: dict) -> str:
    rubric = "\n".join(f"- {k} (weight {w:.0%}): {text}" for k, (w, text) in CRITERIA.items())
    lines = "\n".join(f'{c["id"]} "{c["name"]}": {c["pitch"]}\n    Facts: {dossier[c["id"]]}' for c in field)
    return f"""You are one of ten independent judges choosing a company name.

{JUDGE_BRIEF}

Score each anonymous name on each criterion from 1 (very poor) to 10 (outstanding), using the whole
scale. The facts were gathered impartially; judge them yourself and do not invent others. Also judge
wryness and trade-mark risk where you see them.
{rubric}

Candidates:
{lines}

For every candidate give [fit, gravitas, distinct, ownable, "critique of at most 12 words"].
Reply with JSON only: {{"scores": {{"C01": [7, 6, 5, 8, "critique"], ...}}}}"""


def score(config: str, rep: int, cands: list[dict], dossier: dict) -> dict:
    run = f"{config}-{rep}"
    ledger = Ledger(OUT / f"{run}.calls.jsonl")
    assign = assignments(config, rep)

    def judge(m):
        order = cands[:]
        random.Random(f"{run}-{m}").shuffle(order)
        a = assign[m]
        return chat_with(m, panel_prompt(order, dossier), 16000 + 60 * len(order), ledger, "score",
                         a.get("persona"), a.get("temperature"))
    with cf.ThreadPoolExecutor(len(MODELS)) as ex:
        ballots = dict(zip(MODELS, ex.map(judge, MODELS)))
    marks = {m: {} for m in MODELS}
    for m, b in ballots.items():
        for cid, val in ((b or {}).get("scores") or {}).items():
            if isinstance(val, list) and len(val) >= 4:
                try:
                    parts = {k: max(1.0, min(10.0, float(v))) for k, v in zip(CRITERIA, val[:4])}
                except (TypeError, ValueError):
                    continue
                marks[m][cid] = weighted(parts)
    result = {"run": run, "config": config, "repeat": rep, "assign": assign, "marks": marks,
              "failed": [m for m, b in ballots.items() if not b], "cost": ledger.cost}
    (OUT / f"{run}.json").write_text(json.dumps(result, indent=1))
    print(f"{run}: {sum(1 for m in marks.values() if m)} ballots, failed {result['failed'] or 'none'}, ${ledger.cost:.3f}", flush=True)
    return result


# ---------------------------------------------------------------- rankings

FAMILY = {"gpt-5.6-luna": "openai", "gpt-oss-120b": "openai", "claude-sonnet-5": "anthropic",
          "claude-haiku-4.5": "anthropic", "gemini-3.8-flash": "google", "gemma-4-31b": "google",
          "deepseek-v4-pro": "deepseek", "deepseek-v4-flash": "deepseek", "minimax-m3": "minimax",
          "nemotron-ultra": "nvidia"}


def owners_map(cands):
    """Who may not score each name: its proposers and every model in their families."""
    return {c["id"]: {m for m in FAMILY if FAMILY[m] in {FAMILY[o] for o in c["owners"]}} for c in cands}


def reliability(marks, own, d=0.4, cap=2.0):
    """Judge weight from leave-one-out agreement with the others' consensus (Kendall tau, clipped
    at 0), damped and capped at cap/N. The literature's alternative to proposer-based weighting."""
    judges = [m for m in marks if marks[m]]
    q = {}
    for j in judges:
        others = {m: s for m, s in marks.items() if m != j and s}
        cons = rank_mean(others, own)
        mine = [c for c in marks[j] if c in cons and j not in own[c]]
        a = sorted(mine, key=lambda c: -marks[j][c])
        b = sorted(mine, key=lambda c: -cons[c])
        q[j] = max(0.0, kendall(a, b))
    tot = sum(q.values()) or 1
    n = len(judges)
    w = {j: min(cap / n, (1 - d) / n + d * q[j] / tot) for j in judges}
    z = sum(w.values())
    return {j: v / z for j, v in w.items()}


def rank_mean(marks, own, weights=None):
    totals = {}
    for cid in own:
        vals = [(weights or {}).get(m, 1.0) * s[cid] for m, s in marks.items() if cid in s and m not in own[cid]]
        ws = [(weights or {}).get(m, 1.0) for m, s in marks.items() if cid in s and m not in own[cid]]
        if ws:
            totals[cid] = sum(vals) / sum(ws)
    return totals


PROPOSERS: dict[str, set] = {}


def peerrank(marks, own, d=DAMPING, iters=100):
    """Judge weight = how highly the (weighted) others rate that judge's own proposals."""
    judges = [m for m in marks if marks[m]]
    w = {m: 1 / len(judges) for m in judges}
    props = {m: [cid for cid, o in PROPOSERS.items() if m in o] for m in judges}
    for _ in range(iters):
        quality = {}
        for j in judges:
            vals = []
            for cid in props[j]:
                num = sum(w[i] * marks[i][cid] for i in judges if i != j and cid in marks[i] and i not in own[cid])
                den = sum(w[i] for i in judges if i != j and cid in marks[i] and i not in own[cid])
                if den:
                    vals.append(num / den)
            quality[j] = statistics.mean(vals) if vals else min(
                statistics.mean(v for v in marks[i].values()) for i in judges)
        lo = min(quality.values())
        shifted = {j: q - lo + 1e-6 for j, q in quality.items()}  # rewards being better than the worst proposer
        total = sum(shifted.values())
        new = {j: (1 - d) / len(judges) + d * shifted[j] / total for j in judges}
        if max(abs(new[j] - w[j]) for j in judges) < 1e-9:
            w = new
            break
        w = new
    return w


def rank_borda(marks, own):
    pts = {cid: 0.0 for cid in own}
    for m, s in marks.items():
        eligible = sorted((cid for cid in s if m not in own[cid]), key=lambda c: s[c])
        for k, cid in enumerate(eligible):
            pts[cid] += k / max(1, len(eligible) - 1)
    return pts


def kendall(a: list[str], b: list[str]) -> float:
    common = [x for x in a if x in b]
    pos = {x: i for i, x in enumerate(b)}
    conc = disc = 0
    for x, y in itertools.combinations(common, 2):
        s = (common.index(x) - common.index(y)) * (pos[x] - pos[y])
        conc += s > 0
        disc += s < 0
    return (conc - disc) / max(1, conc + disc)


def corr_stats(marks, ids):
    judges = [m for m in marks if marks[m]]
    rs = []
    for a, b in itertools.combinations(judges, 2):
        common = [c for c in ids if c in marks[a] and c in marks[b]]
        xs, ys = [marks[a][c] for c in common], [marks[b][c] for c in common]
        if len(common) > 3 and statistics.pstdev(xs) and statistics.pstdev(ys):
            rs.append(statistics.correlation(xs, ys))
    rbar = statistics.mean(rs) if rs else None
    n = len(judges)
    return rbar, (n / (1 + (n - 1) * rbar) if rbar and rbar > 0 else None)


# ---------------------------------------------------------------- pairwise finals

def finals(config: str, top: int, cands: list[dict], dossier: dict, rep: int = 1) -> dict:
    """Every pair of the top names, both orders, one call per judge per order; Bradley–Terry fit."""
    runs = [json.loads(p.read_text()) for p in OUT.glob(f"{config}-*.json")]
    own = owners_map(cands)
    agg = {}
    for r in runs:
        for cid, v in rank_mean(r["marks"], own, peerrank(r["marks"], own)).items():
            agg.setdefault(cid, []).append(v)
    ids = [c for c, _ in sorted(((c, statistics.mean(v)) for c, v in agg.items()), key=lambda x: -x[1])[:top]]
    by = {c["id"]: c for c in cands}
    pairs = list(itertools.combinations(ids, 2))
    ledger = Ledger(OUT / f"finals-{config}.calls.jsonl")
    assign = assignments(config, rep)

    def ask(m, flip):
        ps = [(b, a) if flip else (a, b) for a, b in pairs]
        random.Random(f"{m}-{flip}").shuffle(ps)
        lines = "\n".join(f'P{i + 1}: A = "{by[a]["name"]}" ({dossier[a]}) | B = "{by[b]["name"]}" ({dossier[b]})'
                          for i, (a, b) in enumerate(ps))
        prompt = f"""{JUDGE_BRIEF}

Final round. For each pair, give the probability (0-1) that name A is the better company name than
name B, all things considered. Be decisive where you are confident.
{lines}
Reply with JSON only: {{"P1": 0.7, "P2": 0.3, ...}}"""
        a = assign[m]
        reply = chat_with(m, prompt, 12000, ledger, f"finals-{'BA' if flip else 'AB'}", a.get("persona"), a.get("temperature"))
        out = []
        for i, (x, y) in enumerate(ps):
            p = (reply or {}).get(f"P{i + 1}")
            if isinstance(p, (int, float)) and 0 <= p <= 1:
                out.append((m, x, y, float(p)))
        return out
    with cf.ThreadPoolExecutor(len(MODELS)) as ex:
        obs = [o for r in ex.map(lambda a: ask(*a), [(m, f) for m in MODELS for f in (False, True)]) for o in r]
    strength = bradley_terry(ids, obs)
    # Copeland on per-judge verdicts, where a pair that flips when its order is swapped is a tie.
    verdict = {}
    for m, x, y, p in obs:
        key = (m, *sorted((x, y)))
        pa = p if x == key[1] else 1 - p
        verdict.setdefault(key, []).append(pa)
    copeland = {i: 0.0 for i in ids}
    flips = 0
    for (m, a, b), ps in verdict.items():
        if len(ps) == 2 and (ps[0] - 0.5) * (ps[1] - 0.5) < 0:
            flips += 1
            copeland[a] += 0.5
            copeland[b] += 0.5
        else:
            win = a if statistics.mean(ps) >= 0.5 else b
            copeland[win] += 1
    # position bias: mean P(A) over all judgements, ideally 0.5
    pos_bias = statistics.mean(p for *_, p in obs) - 0.5 if obs else None
    result = {"config": config, "ids": ids, "observations": obs, "strength": strength,
              "copeland": copeland, "flip_rate": flips / max(1, len(verdict)),
              "position_bias": pos_bias, "cost": ledger.cost}
    (OUT / f"finals-{config}.json").write_text(json.dumps(result, indent=1))
    for cid in sorted(strength, key=lambda c: -strength[c]):
        print(f"  {by[cid]['name']:24} {strength[cid]:.3f}")
    print(f"finals: {len(obs)} judgements, position bias {pos_bias:+.3f}, flips {flips}/{len(verdict)}, ${ledger.cost:.3f}")
    return result


def bradley_terry(ids, obs, iters=500):
    """Soft-count Bradley–Terry via minorisation-maximisation."""
    wins = {i: 0.0 for i in ids}
    n = {(a, b): 0.0 for a in ids for b in ids if a != b}
    for _, a, b, p in obs:
        wins[a] += p
        wins[b] += 1 - p
        n[(a, b)] += 1
        n[(b, a)] += 1
    s = {i: 1.0 for i in ids}
    for _ in range(iters):
        new = {}
        for i in ids:
            den = sum(n[(i, j)] / (s[i] + s[j]) for j in ids if j != i and n[(i, j)])
            new[i] = wins[i] / den if den else s[i]
        tot = sum(new.values())
        s = {i: v / tot for i, v in new.items()}
    return s


# ---------------------------------------------------------------- analysis

def analyze(cands):
    own = owners_map(cands)
    by = {c["id"]: c["name"] for c in cands}
    facts = json.loads((HERE / "results/dossier-facts.json").read_text())
    clear = [cid for cid, f in facts.items() if f["companies_house"] == "clear"]
    runs = sorted((json.loads(p.read_text()) for p in OUT.glob("*-[0-9].json")), key=lambda r: r["run"])
    out = {"runs": [], "configs": {}}
    base_order = None
    for r in runs:
        marks = {m: {c: v for c, v in s.items() if c in own} for m, s in r["marks"].items()}  # drop invented ids
        w = peerrank(marks, own)
        rw = reliability(marks, own)
        mean = rank_mean(marks, own)
        pr = rank_mean(marks, own, w)
        rel = rank_mean(marks, own, rw)
        borda = rank_borda(marks, own)
        orders = {k: sorted(v, key=lambda c: -v[c]) for k, v in
                  (("mean", mean), ("peerrank", pr), ("reliability", rel), ("borda", borda))}
        rbar, neff = corr_stats(marks, list(own))
        rclear, neff_clear = corr_stats(marks, clear)
        row = {"run": r["run"], "config": r["config"], "cost": r["cost"], "failed": r["failed"],
               "weights": w, "reliability_weights": rw, "top5": {k: [by[c] for c in o[:5]] for k, o in orders.items()},
               "orders": orders, "corr": rbar, "n_eff": neff, "corr_clear": rclear, "n_eff_clear": neff_clear,
               "mean_scores": mean, "peerrank_scores": pr,
               "tau_mean_vs_peerrank": kendall(orders["mean"], orders["peerrank"]),
               "tau_mean_vs_reliability": kendall(orders["mean"], orders["reliability"])}
        out["runs"].append(row)
    for cfg in sorted({r["config"] for r in out["runs"]}):
        rs = [r for r in out["runs"] if r["config"] == cfg]
        stab = [kendall(a["orders"]["mean"], b["orders"]["mean"]) for a, b in itertools.combinations(rs, 2)]
        top1 = [r["orders"]["mean"][0] for r in rs]
        out["configs"][cfg] = {
            "runs": len(rs), "cost": sum(r["cost"] for r in rs),
            "corr": statistics.mean(r["corr"] for r in rs), "n_eff": statistics.mean(r["n_eff"] for r in rs),
            "corr_clear": statistics.mean(r["corr_clear"] for r in rs),
            "n_eff_clear": statistics.mean(r["n_eff_clear"] for r in rs),
            "repeat_stability_tau": statistics.mean(stab) if stab else None,
            "top1": [by[c] for c in top1],
            "weights_range": [min(min(r["weights"].values()) for r in rs), max(max(r["weights"].values()) for r in rs)],
        }
    base = [r for r in out["runs"] if r["config"] == "base"]
    if base:
        for cfg, s in out["configs"].items():
            rs = [r for r in out["runs"] if r["config"] == cfg]
            s["tau_vs_base"] = statistics.mean(kendall(r["orders"]["mean"], b["orders"]["mean"]) for r in rs for b in base)
    for p in OUT.glob("finals-*.json"):
        if p.name.endswith(".calls.jsonl"):
            continue
        f = json.loads(p.read_text())
        out.setdefault("finals", {})[f["config"]] = {
            "ranking": [(by[c], round(f["strength"][c], 4)) for c in sorted(f["strength"], key=lambda c: -f["strength"][c])],
            "copeland": [(by[c], f["copeland"][c]) for c in sorted(f["copeland"], key=lambda c: -f["copeland"][c])],
            "flip_rate": f["flip_rate"],
            "position_bias": f["position_bias"], "judgements": len(f["observations"]), "cost": f["cost"]}
    (OUT / "summary.json").write_text(json.dumps(out, indent=1))
    for cfg, s in out["configs"].items():
        print(cfg, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in s.items()})
    for r in out["runs"]:
        print(r["run"], "mean:", r["top5"]["mean"][:3], "| peerrank:", r["top5"]["peerrank"][:3],
              "| weights", {m: round(v, 3) for m, v in sorted(r["weights"].items(), key=lambda x: -x[1])[:3]})
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["score", "finals", "analyze"])
    ap.add_argument("configs", nargs="*", default=["base", "persona", "temp", "persona_temp"])
    ap.add_argument("--repeats", type=int, default=2)
    ap.add_argument("--config", default="persona_temp")
    ap.add_argument("--top", type=int, default=6)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    cands = json.loads((HERE / "results/proposals.json").read_text())["candidates"]
    PROPOSERS.update({c["id"]: set(c["owners"]) for c in cands})
    dossier = facts_dossier()
    (OUT / "dossier-facts-only.json").write_text(json.dumps(dossier, indent=1))
    if args.command == "score":
        jobs = [(c, r) for r in range(1, args.repeats + 1) for c in args.configs]
        with cf.ThreadPoolExecutor(2) as ex:
            list(ex.map(lambda j: score(j[0], j[1], cands, dossier), jobs))
    elif args.command == "finals":
        finals(args.config, args.top, cands, dossier)
    else:
        analyze(cands)


if __name__ == "__main__":
    main()
