"""Trade-mark screen via TMview (UK IPO, EUIPO and WIPO marks). Screening only, not legal clearance."""
import json, subprocess, sys, time
TERMS = {"Countermand": ["countermand", "countermand labs", "cntermand", "countermond"],
         "Permissa": ["permissa", "permissa labs", "permisa", "permissar", "permisso"],
         "Claustra": ["claustra", "claustra labs", "clausta", "claustr"]}
RELEVANT = {9, 35, 42, 41, 45}
LIVE = ("regist", "filed", "publish", "opposition", "examined", "pending", "accepted", "appeal")

def q(term, mode, page=1):
    body = json.dumps({"page": str(page), "pageSize": "100", "criteria": mode, "basicSearch": term,
                       "fOffices": ["GB", "EM", "WO"]})
    out = subprocess.run(["curl", "-sS", "-m", "60", "-X", "POST",
        "https://www.tmdn.org/tmview/api/search/results?translate=true",
        "-H", "Content-Type: application/json", "-H", "Accept: application/json",
        "-H", "Origin: https://www.tmdn.org", "-H", "Referer: https://www.tmdn.org/tmview/",
        "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
        "-d", body], capture_output=True, text=True).stdout
    return json.loads(out)

results = {}
for name, terms in TERMS.items():
    marks = {}
    for t in terms:
        for mode in ("C", "F"):
            try:
                d = q(t, mode)
            except Exception as e:
                print("fail", t, mode, e); continue
            for m in d.get("tradeMarks", []):
                m["_query"] = f"{t}/{mode}"
                marks.setdefault(m["ST13"], m)
            time.sleep(1)
    results[name] = list(marks.values())
json.dump(results, open("tmview-raw.json", "w"), indent=1)
for name, marks in results.items():
    print(f"\n=== {name}: {len(marks)} marks found")
    for m in sorted(marks, key=lambda m: (m.get("tmName") or "")):
        st = (m.get("tradeMarkStatus") or "").lower()
        live = any(k in st for k in LIVE) and "expired" not in st and "refus" not in st and "withdraw" not in st
        cls = set(m.get("niceClass") or [])
        uk = m["tmOffice"] == "GB" or "GB" in (m.get("tProtection") or []) or m["tmOffice"] == "EM" or "EM" in (m.get("tProtection") or [])
        flag = ("LIVE " if live else "dead ") + ("REL " if cls & RELEVANT else "    ") + ("UK/EU" if uk else "other")
        print(f"  {flag:16} {m.get('tmName')!s:28} {m['tmOffice']} {m.get('tradeMarkStatus')!s:22} cls {sorted(cls)} {', '.join(m.get('applicantName') or [])[:45]}  [{m['_query']}]")
