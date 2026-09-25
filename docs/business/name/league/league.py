#!/usr/bin/env python3
"""Adversarial naming league. Ten models propose names; each name gets the same impartial research
dossier; then the models judge the field blind against a weighted rubric, the scores are shared,
and the field is halved each round until one name is left.

Each round is a three-stage cycle: advocate -> panel -> (Jev). From round 2, every surviving name is
argued for by a randomly assigned model that did not propose it. Nobody is told which names are
theirs; a judge's scores for its own names are dropped silently and kept to measure self-preference.

Variants (all start from the same proposals and dossier, so only the rules differ):
  A  panel, with points for backing the eventual winner early
  B  as A, plus Jev (TypeSafe's calibrated decision model, via OpenRouter) scoring every criterion
     as the third stage of each round, weighted equal to the whole panel
  C  panel only: no backing, no incentive, no Jev

  python3 league.py propose [--fill]          # stage 0, shared by every variant
  (write results/dossier.json: {"C01": "facts...", ...})
  python3 league.py run A B C --repeats 2

LLM calls go through the LiteLLM proxy with this experiment's capped virtual key (.env.local here).
Every call is logged to results/, with its token counts and the proxy's reported cost.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import math
import random
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
PROPOSALS = RESULTS / "proposals.json"

# Chosen for score per dollar (BenchLM, Artificial Analysis, Sept 2026) among what the proxy serves.
# `effort` is sent as reasoning_effort only where the provider accepts it.
MODELS = {
    "gpt-5.6-luna":       {"id": "openai/gpt-5.6-luna", "effort": "low"},
    "claude-sonnet-5":    {"id": "anthropic/claude-sonnet-5"},
    "gemini-3.8-flash":   {"id": "gemini/gemini-3.8-flash", "effort": "low"},
    "deepseek-v4-pro":    {"id": "deepseek/deepseek-v4-pro"},
    "deepseek-v4-flash":  {"id": "deepseek/deepseek-v4-flash"},
    "minimax-m3":         {"id": "minimax/MiniMax-M3"},
    "nemotron-ultra":     {"id": "nvidia/nemotron-ultra-550b", "system": "detailed thinking off"},
    "gpt-oss-120b":       {"id": "cerebras/gpt-oss-120b", "effort": "low"},
    "gemma-4-31b":        {"id": "gemini/gemma-4-31b-it"},
    "claude-haiku-4.5":   {"id": "anthropic/claude-haiku-4-5"},
}

BRIEF = """We are naming a UK company: an AI consulting and products agency for mid-market and enterprise
buyers (CFOs, CISOs, operations leads). Its thesis is an architecture of distrust: AI agents hold
only the capabilities they are given, risky actions wait for human approval, and information flows
only where it may. It aims to be worth £100m, so the name must be sober and weighty, memorable, a
little wry but never silly (think Palantir, Anduril, Thought Machine, Darktrace, Tailscale). Plain
English single words are all taken; coined words, literary or historical borrowings, short phrases
and a "Labs" suffix are fine. It must not clash with a known AI or security company."""

PROPOSALS_PER_MODEL = 3
BACKING_POINTS = [16, 8, 4, 2, 1, 1, 1]  # by panel round; earlier correct backing earns more
SURVIVE_POINTS, WIN_POINTS = 1, 5
BUDGET_USD_PER_RUN = 3.0
# Reasoning models spend most of their allowance thinking; these caps leave room for the answer.
MAX_TOKENS = {"propose": 6000, "advocate": 6000, "panel": 16000}
# A deliberately bland entry that nobody owns. If it survives, the panel is not discriminating.
CONTROL = {"name": "NovaPulse AI Solutions", "pitch": "A modern, innovative name that conveys energy and cutting-edge AI solutions for business.", "owners": [], "control": True}
JEV_URL, JEV_MODEL = "https://openrouter.ai/api/alpha/decisions", "typesafe/jev-1.13"

JUDGE_BRIEF = """THE COMPANY. A UK founder-led business (working name Excelcion, which cannot be used). It builds
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
security or software company."""

# Weighted rubric. Judges score each criterion 1-10; the harness computes the weighted total.
CRITERIA = {
    "fit":      (0.30, "Fit: tells the architecture-of-distrust story (granted capability, human approval, controlled flow)."),
    "gravitas": (0.25, "Gravitas: a CFO or CISO would trust a company with this name; sober, not silly."),
    "distinct": (0.20, "Distinctiveness: memorable, easy to say and spell, stands out from shield/guard/sentinel clichés."),
    "ownable":  (0.25, "Ownability: judged from the dossier: Companies House, domains, clashes with existing companies."),
}
JEV_LEVELS = {
    "fit": ["No connection to the thesis.", "A loose or generic connection.", "Clearly suggests control or approval.",
            "Tells the whole story: granted capability, human approval, controlled flow."],
    "gravitas": ["Silly, cheap or off-putting to an enterprise buyer.", "Neutral; neither trusted nor distrusted.",
                 "Sober and credible.", "Commands trust, like Palantir or Thought Machine."],
    "distinct": ["Generic or cliched; forgotten at once.", "Somewhat memorable.", "Memorable and easy to say.",
                 "Striking, ownable in the mind, and easy to say and spell."],
    "ownable": ["Blocked or clearly clashes with an established AI/security/software company.",
                "Significant clashes or most domains taken.", "Minor clashes; some good domains free.",
                "Clear at Companies House, no relevant clashes, good domains free."],
}


def load_env() -> dict[str, str]:
    """This folder's .env.local (the experiment's proxy key), then the repo root's for OPENROUTER_API_KEY."""
    env = {}
    root = HERE.parents[3] / ".env.local"
    lines = (root.read_text().splitlines() if root.exists() else []) + (HERE / ".env.local").read_text().splitlines()
    for line in lines:
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


ENV = load_env()


class Ledger:
    """Every call, with tokens and cost, appended to a JSONL file."""

    def __init__(self, path: Path):
        self.path, self.cost, self.calls = path, 0.0, 0
        path.parent.mkdir(parents=True, exist_ok=True)

    def add(self, row: dict) -> None:
        self.cost += row.get("cost") or 0
        self.calls += 1
        with self.path.open("a") as f:
            f.write(json.dumps(row) + "\n")
        if self.cost > BUDGET_USD_PER_RUN:
            sys.exit(f"Budget guard: ${self.cost:.2f} spent in this run, over ${BUDGET_USD_PER_RUN}.")


def chat(model: str, prompt: str, max_tokens: int, ledger: Ledger, stage: str,
         persona: str | None = None, temperature: float | None = None) -> dict | None:
    """One completion, parsed as JSON. Retries on a transport or parse failure. A persona is added
    to the model's system prompt; a temperature overrides the provider default."""
    spec = MODELS[model]
    system = "\n\n".join(x for x in (spec.get("system"), persona) if x)
    messages = ([{"role": "system", "content": system}] if system else []) + [
        {"role": "user", "content": prompt}]
    body = {"model": spec["id"], "max_tokens": max_tokens, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if spec.get("effort"):
        body["reasoning_effort"] = spec["effort"]
    for attempt in (1, 2, 3):
        req = urllib.request.Request(
            ENV["LITELLM_PROXY_API_BASE"] + "/v1/chat/completions", json.dumps(body).encode(),
            {"Authorization": "Bearer " + ENV["LITELLM_PROXY_API_KEY"], "Content-Type": "application/json"})
        t0, row = time.time(), {"stage": stage, "model": model, "attempt": attempt}
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.load(r)
                cost = r.headers.get("x-litellm-response-cost")
            usage = data.get("usage") or {}
            text = data["choices"][0]["message"].get("content") or ""
            row.update(ok=True, seconds=round(time.time() - t0, 1), cost=float(cost) if cost else 0.0,
                       prompt_tokens=usage.get("prompt_tokens"), completion_tokens=usage.get("completion_tokens"),
                       text=text)
            parsed = parse_json(text)
            row["parsed"] = parsed is not None
            ledger.add(row)
            if parsed is not None:
                return parsed
        except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as e:
            detail = e.read()[:300].decode(errors="replace") if isinstance(e, urllib.error.HTTPError) else ""
            row.update(ok=False, seconds=round(time.time() - t0, 1), error=f"{e} {detail}".strip())
            ledger.add(row)
            # Free tiers rate-limit when three variants run at once; back off harder for those.
            time.sleep(30 * attempt if getattr(e, "code", None) == 429 else 3)
    return None


def parse_json(text: str):
    """The first JSON value in a reply, repairing the slips models make: a missing closing bracket,
    or a reply cut off mid-ballot (kept up to the last complete entry)."""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start = min([i for i in (text.find("{"), text.find("[")) if i >= 0], default=-1)
    if start < 0:
        return None
    body = text[start:]
    for end in range(len(body), 0, -1):
        try:
            return json.loads(body[:end])
        except ValueError:
            continue
    # A ballot entry closed with } instead of ], mid-list or at the end.
    fixed = re.sub(r'("\s*)[)}](\s*,\s*"C\d+"\s*:)', r"\1]\2", body)
    fixed = re.sub(r'("\s*)\}(\s*,\s*"back")', r"\1]}\2", fixed)
    fixed = re.sub(r'("\s*)\}(\s*\}\s*(?:,\s*"back"[^}]*)?\}\s*)$', r"\1]\2", fixed)
    repairs = [fixed, re.sub(r'"\s*}\s*}\s*$', '"]}}', fixed)]
    cut = body.rfind("],")
    if cut > 0:
        repairs += [body[:cut + 1] + "}}", body[:cut + 1] + "}"]
    for attempt in repairs:
        try:
            return json.loads(attempt)
        except ValueError:
            continue
    return None


def ask_jev(state: dict, questions: dict, ledger: Ledger, stage: str) -> dict:
    """Score questions in batches of 32 (the Decisions API limit)."""
    answers, keys = {}, list(questions)
    for i in range(0, len(keys), 32):
        batch = {k: questions[k] for k in keys[i:i + 32]}
        body = {"model": JEV_MODEL, "provider": {"data_collection": "deny", "zdr": True},
                "state": state, "questions": batch}
        req = urllib.request.Request(JEV_URL, json.dumps(body).encode(), {
            "Authorization": "Bearer " + ENV["OPENROUTER_API_KEY"], "Content-Type": "application/json"})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
        cost = (data.get("usage") or {}).get("cost") or 0.0
        ledger.add({"stage": stage, "model": "jev", "ok": True, "seconds": round(time.time() - t0, 1),
                    "cost": cost, "questions": len(batch), "answers": data.get("answers")})
        answers.update(data.get("answers") or {})
    return answers


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


# ---------------------------------------------------------------- stage 0: proposals (shared)

def propose(fill: bool = False) -> None:
    """Ask every model for names; with fill, ask again only the models that gave none."""
    ledger = Ledger(RESULTS / "proposals.calls.jsonl")
    prompt = f"""{BRIEF}

Propose your {PROPOSALS_PER_MODEL} best names. Each pitch is one sentence of at most 20 words: the
meaning and why it suits the brief. Reply with JSON only:
{{"names": [{{"name": "...", "pitch": "..."}}]}}"""
    prior = json.loads(PROPOSALS.read_text()) if fill else {"candidates": [], "cost": 0.0}
    cands = prior["candidates"]
    have = {m for c in cands for m in c["owners"]}
    models = [m for m in MODELS if m not in have] if fill else list(MODELS)
    tokens = MAX_TOKENS["propose"]
    if fill:  # the models that failed spent their whole allowance deliberating
        prompt += "\nThink briefly: settle on your three names quickly, then answer."
        tokens *= 2
    with cf.ThreadPoolExecutor(len(models)) as ex:
        replies = dict(zip(models, ex.map(lambda m: chat(m, prompt, tokens, ledger, "propose"), models)))
    pool = {norm(c["name"]): c for c in cands}
    fresh = []
    for model, reply in replies.items():
        for item in (reply or {}).get("names", [])[:PROPOSALS_PER_MODEL]:
            name = str(item.get("name", "")).strip()
            if not re.search(r"[A-Za-z]{3}", name):
                continue
            if norm(name) in pool:
                pool[norm(name)]["owners"].append(model)
                continue
            entry = pool[norm(name)] = {"name": name, "pitch": str(item.get("pitch", ""))[:200], "owners": [model]}
            fresh.append(entry)
    if not fill:
        fresh.append(dict(CONTROL))
    random.Random(7 + len(cands)).shuffle(fresh)
    for i, c in enumerate(fresh, len(cands) + 1):
        c["id"] = f"C{i:02d}"
    cands = cands + fresh
    PROPOSALS.write_text(json.dumps({"brief": BRIEF, "candidates": cands, "cost": prior["cost"] + ledger.cost}, indent=1))
    print(f"{len(fresh)} new candidates from {sum(1 for r in replies.values() if r)}/{len(models)} models, ${ledger.cost:.4f}")
    for c in cands:
        print(f"  {c['id']} {c['name']:28} {', '.join(c['owners'])}")


# ---------------------------------------------------------------- league rounds

def load_dossier() -> dict[str, str]:
    path = RESULTS / "dossier.json"
    return json.loads(path.read_text()) if path.exists() else {}


def weighted(parts: dict[str, float]) -> float:
    return sum(CRITERIA[k][0] * parts[k] for k in CRITERIA)


def candidate_block(c: dict, dossier: dict[str, str]) -> str:
    return f'{c["id"]} "{c["name"]}": {c["pitch"]}\n    Research: {dossier.get(c["id"], "none")}'


def panel_prompt(variant: str, rnd: int, field: list[dict], history: str, dossier: dict) -> str:
    keep = math.ceil(len(field) / 2)
    rubric = "\n".join(f"- {k} (weight {w:.0%}): {text}" for k, (w, text) in CRITERIA.items())
    backing = ""
    if variant in "AB":
        pts = ", ".join(str(p) for p in BACKING_POINTS[:5])
        backing = f"""
Separately, back the ONE name you predict will WIN the whole league. If it wins, you earn points for
every round you backed it: {pts} for rounds 1-5, so backing the eventual winner early pays most (this
round is worth {BACKING_POINTS[rnd - 1]}). You may change your pick each round. Add "back": "<id>"."""
    jev = ("\nA calibrated decision model, Jev, also scores every criterion after the panel; its score "
           "counts as much as the whole panel's." if variant == "B" else "")
    return f"""You are one of ten independent judges in a company-naming league.

{JUDGE_BRIEF}

Round {rnd}: {len(field)} anonymous names remain and the top {keep} by weighted score go through.{jev}
Score each name on each criterion from 1 (very poor) to 10 (outstanding). Use the whole scale and
rely on the research, which was gathered impartially; do not invent facts about existing companies.
{rubric}
{history}
Candidates (with impartial research):
{chr(10).join(candidate_block(c, dossier) for c in field)}

For every candidate give [fit, gravitas, distinct, ownable, "critique of at most 12 words"].{backing}
Reply with JSON only: {{"scores": {{"C01": [7, 6, 5, 8, "critique"], ...}}{', "back": "C05"' if variant in "AB" else ""}}}"""


def advocate_prompt(assigned: list[dict], critiques: dict[str, list[str]], dossier: dict) -> str:
    blocks = "\n".join(
        f'{candidate_block(c, dossier)}\n    Score so far {c["score"]:.1f}. Judges said: ' + " | ".join(critiques.get(c["id"], [])[:4])
        for c in assigned)
    return f"""{JUDGE_BRIEF}

You have been assigned to argue FOR the names below in a naming league; you did not propose them.
For each, make the strongest honest case in at most 30 words, answering the harshest critique. Do not
invent facts beyond the research and do not attack other names.
{blocks}
Reply with JSON only: {{"cases": {{"C01": "..."}}}}"""


def history_block(field: list[dict], critiques: dict, cases: dict, variant: str) -> str:
    if not critiques:
        return ""
    rows = []
    for c in field:
        crit = critiques.get(c["id"], [])
        picked = [crit[0], crit[-1]] if len(crit) > 1 else crit
        line = f'{c["id"]}: last round panel {c["panel"]:.1f}'
        if variant == "B" and "jev" in c:
            line += f', Jev {c["jev"]:.1f}'
        line += " | harshest and kindest critique: " + " | ".join(picked)
        if c["id"] in cases:
            line += f' | Advocate: {cases[c["id"]]}'
        rows.append(line)
    return "\nShared results from the last round:\n" + "\n".join(rows) + "\n"


def jev_round(field: list[dict], dossier: dict, ledger: Ledger, stage: str) -> dict[str, dict[str, float]]:
    state = {"brief": JUDGE_BRIEF, "candidates": [
        {"id": c["id"], "name": c["name"], "pitch": c["pitch"], "research": dossier.get(c["id"], "")} for c in field]}
    qs = {f'{c["id"]}_{k}': {"type": "score", "criteria": JEV_LEVELS[k],
                             "instructions": f'Candidate {c["id"]} ("{c["name"]}"). {CRITERIA[k][1]}'}
          for c in field for k in CRITERIA}
    answers = ask_jev(state, qs, ledger, stage)
    out: dict[str, dict[str, float]] = {}
    for c in field:
        parts = {}
        for k in CRITERIA:
            a = answers.get(f'{c["id"]}_{k}') or {}
            if isinstance(a.get("score"), (int, float)):
                parts[k] = 1 + 9 * a["score"] / (len(JEV_LEVELS[k]) - 1)
                parts[k + "_confidence"] = a.get("confidence")
        if all(k in parts for k in CRITERIA):
            out[c["id"]] = parts
    return out


def run_variant(variant: str, rep: int, proposals: dict, dossier: dict) -> dict:
    run_id = f"{variant}{rep}"
    ledger = Ledger(RESULTS / f"run-{run_id}.calls.jsonl")
    rng = random.Random(f"{run_id}-league")
    field = [dict(c) for c in proposals["candidates"]]
    by_id = {c["id"]: c for c in field}
    owns = {m: {c["id"] for c in field if m in c["owners"]} for m in MODELS}
    rounds, backings = [], {m: [] for m in MODELS}
    critiques: dict[str, list[str]] = {}
    rnd = 0
    while len(field) > 1:
        rnd += 1
        # Stage 1: advocates (never the proposer) make the case for each surviving name, from round 2.
        cases: dict[str, str] = {}
        if rnd > 1:
            assign: dict[str, list[dict]] = {m: [] for m in MODELS}
            for c in field:
                options = [m for m in MODELS if m not in c["owners"]]
                options.sort(key=lambda m: (len(assign[m]), rng.random()))
                assign[options[0]].append(c)
            jobs = {m: a for m, a in assign.items() if a}
            with cf.ThreadPoolExecutor(len(jobs)) as ex:
                futs = {m: ex.submit(chat, m, advocate_prompt(a, critiques, dossier), MAX_TOKENS["advocate"], ledger,
                                     f"r{rnd}-advocate") for m, a in jobs.items()}
            for m, fut in futs.items():
                allowed = {c["id"] for c in jobs[m]}
                for cid, text in ((fut.result() or {}).get("cases") or {}).items():
                    if cid in allowed:
                        cases[cid] = " ".join(str(text).split()[:35])
        history = history_block(field, critiques, cases, variant)

        # Stage 2: the panel scores every surviving name on the rubric, each judge in its own order.
        def judge(m):
            order = field[:]
            random.Random(f"{run_id}-{rnd}-{m}").shuffle(order)
            return chat(m, panel_prompt(variant, rnd, order, history, dossier),
                        MAX_TOKENS["panel"] + 60 * len(field), ledger, f"r{rnd}-panel")
        with cf.ThreadPoolExecutor(len(MODELS)) as ex:
            ballots = dict(zip(MODELS, ex.map(judge, MODELS)))

        marks: dict[str, dict[str, dict]] = {c["id"]: {} for c in field}
        self_marks, notes = [], {c["id"]: [] for c in field}
        for m, ballot in ballots.items():
            for cid, val in ((ballot or {}).get("scores") or {}).items():
                if cid not in marks or not isinstance(val, list) or len(val) < 4:
                    continue
                try:
                    parts = {k: max(1.0, min(10.0, float(v))) for k, v in zip(CRITERIA, val[:4])}
                except (TypeError, ValueError):
                    continue
                entry = {**parts, "total": weighted(parts)}
                if cid in owns[m]:  # silently excluded; kept to measure self-preference
                    self_marks.append({"judge": m, "id": cid, **entry})
                    continue
                marks[cid][m] = entry
                note = str(val[4]) if len(val) > 4 else ""
                if note:
                    notes[cid].append((entry["total"], " ".join(note.split()[:14])))
            if variant in "AB":
                pick = (ballot or {}).get("back")
                backings[m].append(pick if pick in marks else None)
        critiques = {cid: [t for _, t in sorted(v)] for cid, v in notes.items()}
        for c in field:
            vals = [e["total"] for e in marks[c["id"]].values()]
            c["panel"] = statistics.mean(vals) if vals else 0.0
            c["score"] = c["panel"]
            c.pop("jev", None)

        # Stage 3 (variant B): Jev scores every criterion; it weighs as much as the whole panel.
        jev = {}
        if variant == "B":
            jev = jev_round(field, dossier, ledger, f"r{rnd}-jev")
            for c in field:
                if c["id"] in jev:
                    c["jev"] = weighted(jev[c["id"]])
                    c["score"] = (c["panel"] + c["jev"]) / 2

        keep = math.ceil(len(field) / 2)
        ranked = sorted(field, key=lambda c: (-c["score"], rng.random()))
        rounds.append({
            "round": rnd, "field": [c["id"] for c in ranked], "keep": keep,
            "scores": {c["id"]: {"score": round(c["score"], 3), "panel": round(c["panel"], 3),
                                 "jev": round(c["jev"], 3) if "jev" in c else None,
                                 "jev_parts": jev.get(c["id"]),
                                 "by_judge": marks[c["id"]]} for c in ranked},
            "critiques": critiques, "cases": cases, "self_marks": self_marks,
            "backings": {m: b[-1] for m, b in backings.items() if b},
            "failed_ballots": [m for m, b in ballots.items() if not b],
            "cost_so_far": round(ledger.cost, 5),
        })
        print(f"  {run_id} round {rnd}: {len(field)} -> {keep}; top {ranked[0]['name']} {ranked[0]['score']:.2f}; "
              f"failed {rounds[-1]['failed_ballots'] or 'none'}; ${ledger.cost:.4f}", flush=True)
        field = ranked[:keep]
    winner = field[0]

    # League table: proposer points for surviving and winning; backing points in A and B.
    table = {m: {"proposer": 0, "backing": 0} for m in MODELS}
    for r in rounds:
        for cid in r["field"][:r["keep"]]:
            for m in by_id[cid]["owners"]:
                table[m]["proposer"] += SURVIVE_POINTS
    for m in winner["owners"]:
        table[m]["proposer"] += WIN_POINTS
    if variant in "AB":
        for m, picks in backings.items():
            table[m]["backing"] = sum(BACKING_POINTS[i] for i, p in enumerate(picks) if p == winner["id"])
            table[m]["first_correct_round"] = next((i + 1 for i, p in enumerate(picks) if p == winner["id"]), None)
    for m in table:
        table[m]["total"] = table[m]["proposer"] + table[m]["backing"]

    result = {"run": run_id, "variant": variant, "repeat": rep, "winner": winner["id"],
              "winner_name": winner["name"], "rounds": rounds, "backings": backings, "table": table,
              "cost": round(ledger.cost, 5), "calls": ledger.calls}
    (RESULTS / f"run-{run_id}.json").write_text(json.dumps(result, indent=1))
    print(f"{run_id}: winner {winner['id']} {winner['name']} (by {', '.join(winner['owners']) or 'control'}); "
          f"${ledger.cost:.4f}, {ledger.calls} calls", flush=True)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["propose", "run"])
    ap.add_argument("variants", nargs="*", default=["A", "B", "C"])
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--first-repeat", type=int, default=1)
    ap.add_argument("--fill", action="store_true", help="propose: re-ask only models that gave no names")
    args = ap.parse_args()
    if args.command == "propose":
        return propose(args.fill)
    proposals, dossier = json.loads(PROPOSALS.read_text()), load_dossier()
    missing = [c["id"] for c in proposals["candidates"] if c["id"] not in dossier]
    if missing:
        sys.exit(f"No research dossier for {', '.join(missing)}; write results/dossier.json first.")
    if "B" in args.variants and not ENV.get("OPENROUTER_API_KEY"):
        sys.exit("Variant B needs OPENROUTER_API_KEY for Jev.")
    for rep in range(args.first_repeat, args.first_repeat + args.repeats):
        with cf.ThreadPoolExecutor(len(args.variants)) as ex:
            list(ex.map(lambda v: run_variant(v, rep, proposals, dossier), args.variants))


if __name__ == "__main__":
    main()
