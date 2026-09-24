# Smoke test of the Python `jira` client against a running handleJira server.
# Usage: uv run --with jira python python_jira_smoke.py <base-url>
# Prints one JSON line per step; exits non-zero on the first failure.

import json
import sys

from jira import JIRA

base = sys.argv[1]
results = []


def step(name, fn):
    try:
        value = fn()
        shown = value if isinstance(value, (str, int, float, bool, list, dict, type(None))) else repr(value)
        results.append({"step": name, "ok": True, "value": shown})
        return value
    except Exception as exc:  # noqa: BLE001 - report every failure verbatim
        results.append({"step": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:600]})
        print(json.dumps(results))
        sys.exit(1)


jira = step("connect", lambda: JIRA(server=base, basic_auth=("alice@example.test", "not-a-real-token"), get_server_info=True, max_retries=0))
step("server_info", lambda: jira.server_info()["deploymentType"])
step("myself", lambda: jira.myself()["displayName"])
step("projects", lambda: [p.key for p in jira.projects()])
step("project", lambda: jira.project("ENG").name)
step("fields", lambda: len(jira.fields()))
issue = step(
    "create_issue",
    lambda: jira.create_issue(project="ENG", summary="From python", description="plain body", issuetype={"name": "Task"}, priority={"name": "High"}),
)
key = issue.key if hasattr(issue, "key") else issue
step("issue", lambda: [jira.issue(key).fields.summary, jira.issue(key).fields.priority.name])
step("update", lambda: jira.issue(key).update(summary="Edited from python") or jira.issue(key).fields.summary)
step("transitions", lambda: [t["name"] for t in jira.transitions(key)])
step("transition_issue", lambda: jira.transition_issue(key, "To do") or jira.issue(key).fields.status.name)
step("add_comment", lambda: jira.add_comment(key, "python comment").body)
step("comments", lambda: [c.body for c in jira.comments(key)])
step("assign", lambda: jira.assign_issue(key, "22222222-2222-4222-8222-222222222222"))
if hasattr(jira, "enhanced_search_issues"):
    step("enhanced_search_issues", lambda: [i.key for i in jira.enhanced_search_issues("project = ENG ORDER BY key ASC", maxResults=10)])
step("search_issues", lambda: [i.key for i in jira.search_issues("project = ENG ORDER BY key ASC", maxResults=10)])
print(json.dumps(results))
