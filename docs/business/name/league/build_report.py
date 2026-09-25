#!/usr/bin/env python3
"""Render report.html from results/summary.json, the dossier facts, findings.json and recs.json."""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.argv = sys.argv[:1]
from league import CRITERIA  # noqa: E402

summary = json.loads((HERE / "results/summary.json").read_text())
facts = json.loads((HERE / "results/dossier-facts.json").read_text())
summary["dossier_facts"] = facts
summary["rubric"] = [[k, w, t] for k, (w, t) in CRITERIA.items()]
findings = HERE / "findings.json"
summary["findings"] = json.loads(findings.read_text()) if findings.exists() else []
recs = json.loads((HERE / "recs.json").read_text())


def md_html(md: str) -> str:
    """Enough Markdown for the reviews: headings, lists, paragraphs, bold, italics, code."""
    import html
    import re

    def inline(t):
        t = html.escape(t)
        t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
        t = re.sub(r"(?<![*\w])\*(?!\s)(.+?)\*(?!\w)", r"<i>\1</i>", t)
        return re.sub(r"`(.+?)`", r"<code>\1</code>", t)
    out, lst, para = [], None, []

    def flush():
        nonlocal lst
        if para:
            out.append("<p>" + inline(" ".join(para)) + "</p>")
            para.clear()
        if lst:
            out.append(f"</{lst}>")
            lst = None
    for line in md.splitlines():
        t = line.strip()
        m_head = re.match(r"^#{1,6}\s+(.*)", t) or re.match(r"^(?:\d+\.\s+)?\*\*([^*]+)\*\*\.?:?$", t)
        m_item = re.match(r"^(?:[-*]|\d+\.)\s+(.*)", t)
        if not t:
            flush()
        elif m_head:
            flush()
            out.append("<h4>" + inline(m_head.group(1).rstrip(".:")) + "</h4>")
        elif m_item:
            if para:
                flush()
            kind = "ol" if t[0].isdigit() else "ul"
            if lst != kind:
                if lst:
                    out.append(f"</{lst}>")
                out.append(f"<{kind}>")
                lst = kind
            out.append("<li>" + inline(m_item.group(1)) + "</li>")
        else:
            if lst:
                flush()
            para.append(t)
    flush()
    return "".join(out)


reviews_path = HERE / "results/reviews.json"
summary["reviews"] = [{**r, "html": md_html(r["markdown"])} for r in
                      (json.loads(reviews_path.read_text()) if reviews_path.exists() else [])]
for run in summary["runs"]:  # the page needs only the aggregates
    run.pop("judge_pairs", None)
v2 = HERE / "results/v2/summary.json"
if v2.exists():
    v = json.loads(v2.read_text())
    for r in v["runs"]:
        r.pop("orders", None)
        r.pop("mean_scores", None)
        r.pop("peerrank_scores", None)
    quest = json.loads((HERE / "results/jev-quest/results.json").read_text())
    league_jev = json.loads((HERE / "results/jev-quest/league-names.json").read_text())
    ch = {}
    for line in (HERE / "results/jev-quest/namecheck.md").read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 5 and cells[0] not in ("Name", "---"):
            ch[cells[0]] = cells[1]
        if len(cells) == 4 and cells[0] not in ("Name", "---"):
            ch.setdefault("_dom", {})[cells[0]] = [d for d in cells[1].split(", ") if d and d != "—" and "-" not in d][:3]
    top = list(quest["names"].items())[:12]
    summary["v2"] = {"configs": v["configs"], "runs": v["runs"], "finals": v.get("finals", {}),
                     "quest": {"rounds": quest["rounds"], "cost": quest["cost"], "total": len(quest["names"]),
                               "top": [[n, s, ch.get(n), ch.get("_dom", {}).get(n)] for n, s in top]},
                     "league_jev": sorted(league_jev.items(), key=lambda kv: -kv[1]["total"])}
q2 = HERE / "results/jev-quest2/results.json"
if q2.exists() and "v2" in summary:
    q = json.loads(q2.read_text())
    avail = {}
    for line in (HERE / "results/jev-quest2/namecheck.md").read_text().splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 5 and cells[0] not in ("Name", "---"):
            avail.setdefault(cells[0], {})["ch"] = cells[1]
        if len(cells) == 4 and cells[0] not in ("Name", "---"):
            avail.setdefault(cells[0], {})["dom"] = [d for d in cells[1].split(", ") if d and d != "—" and "-" not in d][:3]
    summary["v2"]["quest2"] = {"rounds": q["rounds"], "cost": q["cost"], "judgements": q["judgements"],
                               "total": len(q["table"]), "top": [{**t, **avail.get(t["name"], {})} for t in q["table"][:16]]}
v2f = HERE / "v2-findings.json"
summary["v2_findings"] = json.loads(v2f.read_text()) if v2f.exists() else []
page = (HERE / "report.template.html").read_text()
page = page.replace("/*DATA*/null", json.dumps(summary, default=float).replace("</", "<\\/"))
page = page.replace("/*RECS*/null", json.dumps(recs).replace("</", "<\\/"))
(HERE / "report.html").write_text(page)
print(f"report.html {len(page) // 1024} KB")
