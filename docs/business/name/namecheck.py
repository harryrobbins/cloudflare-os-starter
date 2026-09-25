#!/usr/bin/env python3
"""Screen candidate business names: domain registration and Companies House conflicts.

Standard library only. Examples:

    python3 namecheck.py domains Lumora "Brass Lantern"
    python3 namecheck.py companies Lumora
    python3 namecheck.py all --file candidates.txt --out results.md

Domains are checked against the registry itself (RDAP, falling back to WHOIS
for TLDs without RDAP, such as .io and .co). "available" means the registry
has no registration; a registrar may still price it as premium or reserve it.

Companies House results are advisory. The Registrar's "same as" rules are
approximated by `normalise()`; confirm a shortlist with the official checker:
https://find-and-update.company-information.service.gov.uk/company-name-availability
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_TLDS = ["com", "co.uk", "uk", "io", "ai", "co"]
USER_AGENT = "namecheck/1.0 (business name screening)"
CH_API = "https://api.company-information.service.gov.uk"
CH_CHECKER = "https://find-and-update.company-information.service.gov.uk/company-name-availability"

# ---------------------------------------------------------------- helpers


# One request at a time per host: registries such as Nominet reset parallel connections.
_host_locks: dict[str, threading.Lock] = {}
_host_locks_guard = threading.Lock()


def http_get(url: str, headers: dict[str, str] | None = None, timeout: float = 15) -> tuple[int, bytes]:
    host = urllib.parse.urlsplit(url).hostname or ""
    with _host_locks_guard:
        lock = _host_locks.setdefault(host, threading.Lock())
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(4):
        try:
            with lock, urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()
        except OSError:
            if attempt == 3:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("unreachable")


def load_env() -> None:
    """Read KEY=value lines from local env files without overriding the real environment."""
    repo_root = HERE.parents[2]
    for env_file in (HERE / ".env", HERE / ".env.local", repo_root / ".env.local"):
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            line = line.strip().removeprefix("export ")
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def labels_for(name: str) -> list[str]:
    """Domain labels for a name: 'Brass Lantern' -> ['brasslantern', 'brass-lantern']."""
    words = re.findall(r"[a-z0-9]+", name.lower().replace("&", " and "))
    labels = ["".join(words)]
    if len(words) > 1:
        labels.append("-".join(words))
    return [label for label in labels if label]


# ---------------------------------------------------------------- domains

_rdap_bootstrap: dict[str, str] | None = None


def rdap_servers() -> dict[str, str]:
    global _rdap_bootstrap
    if _rdap_bootstrap is None:
        status, body = http_get("https://data.iana.org/rdap/dns.json")
        if status != 200:
            raise RuntimeError(f"IANA RDAP bootstrap returned HTTP {status}")
        data = json.loads(body)
        _rdap_bootstrap = {tld: urls[0] for tlds, urls in data["services"] for tld in tlds}
    return _rdap_bootstrap


def whois_query(server: str, query: str) -> str:
    with socket.create_connection((server, 43), timeout=15) as sock:
        sock.sendall((query + "\r\n").encode())
        chunks = []
        while chunk := sock.recv(4096):
            chunks.append(chunk)
    return b"".join(chunks).decode(errors="replace")


_NOT_FOUND = re.compile(
    r"no match|not found|no entries found|no data found|status:\s*free|status:\s*available|does not exist",
    re.I,
)


def check_domain(domain: str) -> tuple[str, str]:
    """Return (status, detail); status is 'available', 'taken' or 'unknown'."""
    tld = domain.rsplit(".", 1)[-1]
    try:
        server = rdap_servers().get(tld)
        if server:
            url = server.rstrip("/") + "/domain/" + domain
            status, _ = http_get(url, {"Accept": "application/rdap+json"})
            if status == 404:
                return "available", "rdap"
            if status == 200:
                return "taken", "rdap"
            if status != 429:
                return "unknown", f"rdap HTTP {status}"
            time.sleep(2)
            status, _ = http_get(url, {"Accept": "application/rdap+json"})
            return {404: "available", 200: "taken"}.get(status, "unknown"), f"rdap HTTP {status}"
        referral = whois_query("whois.iana.org", tld)
        match = re.search(r"^whois:\s*(\S+)", referral, re.M)
        if not match:
            return "unknown", "no RDAP or WHOIS server"
        reply = whois_query(match.group(1), domain)
        if _NOT_FOUND.search(reply):
            return "available", "whois"
        if re.search(r"domain name:", reply, re.I):
            return "taken", "whois"
        return "unknown", "whois reply unrecognised"
    except (OSError, RuntimeError, ValueError) as err:
        return "unknown", str(err)


def check_domains(names: list[str], tlds: list[str]) -> dict[str, list[tuple[str, str, str]]]:
    jobs = [(name, f"{label}.{tld}") for name in names for label in labels_for(name) for tld in tlds]
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda job: (job[0], job[1], *check_domain(job[1])), jobs))
    by_name: dict[str, list[tuple[str, str, str]]] = {name: [] for name in names}
    for name, domain, status, detail in results:
        by_name[name].append((domain, status, detail))
    return by_name


# ---------------------------------------------------------------- Companies House

# Endings the Registrar disregards when comparing names (company-type designations).
_LEGAL_SUFFIXES = [
    "public limited company", "limited liability partnership", "community interest company",
    "community interest public limited company", "cwmni buddiant cymunedol", "partneriaeth atebolrwydd cyfyngedig",
    "cwmni cyfyngedig cyhoeddus", "limited", "ltd", "plc", "llp", "cic", "cyfyngedig", "cyf", "ccc", "pac",
    "unlimited", "unltd", "ultd", "and company", "and co", "company", "co",
]
# Generic endings that do not make a name distinct in practice; treated as "too like" risk.
_GENERIC_SUFFIXES = [
    "uk", "united kingdom", "gb", "great britain", "england", "international", "holdings", "holding",
    "group", "services", "service", "solutions", "consulting", "consultancy", "partners", "global",
    "europe", "technology", "technologies", "tech", "ventures",
]
_EQUIVALENTS = [
    (r"&", " and "), (r"\+", " plus "), (r"@", " at "), (r"%", " percent "), (r"£", " pound "),
    (r"\$", " dollar "), (r"€", " euro "), (r"#", " hash "), (r"\bno\.?\s", " number "),
]


def _strip_endings(words: list[str], endings: list[str]) -> list[str]:
    changed = True
    while changed and words:
        changed = False
        for ending in sorted(endings, key=len, reverse=True):
            parts = ending.split()
            if len(words) > len(parts) and words[-len(parts):] == parts:
                words = words[: -len(parts)]
                changed = True
                break
    return words


def normalise(name: str, strict: bool = True) -> str:
    """Approximate Companies House comparison key.

    strict=True  approximates the statutory "same as" test (casing, punctuation,
                 spacing, a leading "the", symbol equivalents, web endings and
                 company-type designations are ignored).
    strict=False also drops generic endings like "group" or "uk", which the
                 Registrar may treat as "too like" an existing name.
    """
    text = name.lower()
    for pattern, replacement in _EQUIVALENTS:
        text = re.sub(pattern, replacement, text)
    text = re.sub(r"^\s*www\.", "", text)
    text = re.sub(r"\.(com|co\.uk|org\.uk|net|org|uk|io|ai|co)\s*$", "", text)
    words = re.findall(r"[a-z0-9]+", text)
    if words[:1] == ["the"] and len(words) > 1:
        words = words[1:]
    words = _strip_endings(words, _LEGAL_SUFFIXES)
    if not strict:
        words = _strip_endings(words, _LEGAL_SUFFIXES + _GENERIC_SUFFIXES)
    return "".join(words)


def ch_get(path: str, params: dict[str, str | int]) -> dict:
    key = os.environ.get("COMPANIES_HOUSE_API_KEY_REST") or os.environ.get("COMPANIES_HOUSE_API_KEY")
    if not key:
        raise SystemExit(
            "COMPANIES_HOUSE_API_KEY_REST is not set. Put it in the repo-root .env.local "
            "(see .env.example) or export it."
        )
    auth = base64.b64encode(f"{key}:".encode()).decode()
    url = f"{CH_API}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(3):
        status, body = http_get(url, {"Authorization": f"Basic {auth}", "Accept": "application/json"})
        if status == 200:
            return json.loads(body)
        if status == 429 and attempt < 2:
            time.sleep(10 * (attempt + 1))
            continue
        if status == 401:
            raise SystemExit("Companies House rejected the key (HTTP 401). Use a REST API key, not a streaming key.")
        raise RuntimeError(f"Companies House {path} returned HTTP {status}: {body[:200]!r}")
    return {}


_CLOSED = {"dissolved", "converted-closed", "closed"}


def check_company_name(name: str) -> dict:
    strict_key, loose_key = normalise(name), normalise(name, strict=False)
    items = ch_get("/search/companies", {"q": name, "items_per_page": 100}).get("items", [])
    same, too_like, similar = [], [], []
    for item in items:
        title = item.get("title", "")
        entry = {
            "title": title,
            "number": item.get("company_number"),
            "status": item.get("company_status", "unknown"),
        }
        if normalise(title) == strict_key:
            same.append(entry)
        elif normalise(title, strict=False) == loose_key:
            too_like.append(entry)
        elif loose_key and loose_key in normalise(title, strict=False):
            similar.append(entry)
    active_same = [e for e in same if e["status"] not in _CLOSED]
    if active_same:
        verdict = "blocked"
    elif [e for e in too_like if e["status"] not in _CLOSED]:
        verdict = "at risk"
    else:
        verdict = "clear"
    return {"name": name, "verdict": verdict, "same": same, "too_like": too_like, "similar": similar}


# ---------------------------------------------------------------- output


def fmt_company(entry: dict) -> str:
    return f"{entry['title']} ({entry['number']}, {entry['status']})"


def render_domains(results: dict[str, list[tuple[str, str, str]]]) -> list[str]:
    lines = ["## Domains", "", "| Name | Available | Taken | Unknown |", "|---|---|---|---|"]
    for name, rows in results.items():
        cols = {s: [d for d, st, _ in rows if st == s] for s in ("available", "taken", "unknown")}
        unknown = [f"{d} ({detail})" for d, st, detail in rows if st == "unknown"]
        lines.append(
            f"| {name} | {', '.join(cols['available']) or '—'} | {', '.join(cols['taken']) or '—'} "
            f"| {', '.join(unknown) or '—'} |"
        )
    return lines + [""]


def render_companies(results: list[dict]) -> list[str]:
    lines = ["## Companies House", "", "| Name | Verdict | Same as | Too like | Contains the name |", "|---|---|---|---|---|"]
    for r in results:
        cells = [
            "; ".join(fmt_company(e) for e in r[k][:5]) + (f" +{len(r[k]) - 5} more" if len(r[k]) > 5 else "")
            for k in ("same", "too_like", "similar")
        ]
        lines.append(f"| {r['name']} | {r['verdict']} | " + " | ".join(c or "—" for c in cells) + " |")
    lines += [
        "",
        "Verdicts: **blocked** = a live company has the same name under the statutory comparison; "
        "**at risk** = a live company differs only by a generic ending (group, uk, services…); "
        "**clear** = neither. Dissolved companies are listed but do not block.",
        f"Advisory only — confirm a shortlist at {CH_CHECKER} and check UK IPO trade marks.",
        "",
    ]
    return lines


# ---------------------------------------------------------------- CLI


def read_names(args: argparse.Namespace) -> list[str]:
    names = list(args.names)
    if args.file:
        for line in Path(args.file).read_text().splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                names.append(line)
    if not names:
        raise SystemExit("Give at least one name, or --file with one name per line.")
    return list(dict.fromkeys(names))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["domains", "companies", "all"])
    parser.add_argument("names", nargs="*", help="candidate names (quote multi-word names)")
    parser.add_argument("--file", help="text file with one name per line; # starts a comment")
    parser.add_argument("--tlds", default=",".join(DEFAULT_TLDS), help=f"comma-separated (default {','.join(DEFAULT_TLDS)})")
    parser.add_argument("--out", help="also write the markdown report to this file")
    parser.add_argument("--json", action="store_true", help="print raw JSON instead of markdown")
    args = parser.parse_args()

    load_env()
    names = read_names(args)
    tlds = [t.strip().lstrip(".") for t in args.tlds.split(",") if t.strip()]
    report: dict = {}
    lines = [f"# Name check — {time.strftime('%Y-%m-%d %H:%M')}", ""]

    if args.command in ("domains", "all"):
        report["domains"] = check_domains(names, tlds)
        lines += render_domains(report["domains"])
    if args.command in ("companies", "all"):
        report["companies"] = [check_company_name(n) for n in names]
        lines += render_companies(report["companies"])

    output = json.dumps(report, indent=2) if args.json else "\n".join(lines)
    print(output)
    if args.out:
        Path(args.out).write_text(output + "\n")
        print(f"\nWritten to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
