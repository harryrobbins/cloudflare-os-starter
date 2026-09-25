# Jira client compatibility

> **Existing implementation.** The new generic Records direction is documented in
> [records-direction.md](../../docs/plans/external_datastores/records-direction.md).
> This package documentation describes the earlier runtime; it does not claim the new service is built.

> This package is an optional compatibility adapter for the Projects example module. It is not part of
> the datastore core; see [the reframing](../../docs/plans/external_datastores/app-datastore-service.md).

What real Jira clients call on this surface, and what they assume about the answers. The evidence is
the request log of the compatibility tests, which serve `handleJira` from a local `node:http` server
over an in-memory `JiraPort` (`__tests__/support/`).

```sh
pnpm -C packages/records-jira exec vitest run                                  # includes jira.js
RECORDS_JIRA_PYTHON=1 pnpm -C packages/records-jira exec vitest run compat-python  # Python `jira` via uv
JIRA_COMPAT_LOG=1 …                                                             # print the request log
AUDIT_SCHEMAS=true … compat-jirajs                                              # jira.js strict schema audit
```

Status (2026-09-24): jira.js 6.2.0 passes; Python `jira` 3.10.5 passes; jira-cli and go-jira are
pending (not installed; fetching them needs network access to GitHub / the Go module proxy).

## jira.js 6.2.0

jira.js 6 removed `Version2Client` and `Version3Client`. There is one client, `createCloudClient`,
generated from the v3 spec. It sends v3 requests, except that a **string** rich-text value on
`createIssue` or `addComment` is routed through v2 (and the comment is then read back through v3).
Every response is validated against jira.js's zod schemas; the test runs with
`onSchemaMismatch: "throw"`, so any shape drift fails the test.

| Call | Request | Notes |
| --- | --- | --- |
| `serverInfo.getServerInfo` | `GET /rest/api/3/serverInfo` | `buildDate`, `serverTime` are coerced to dates |
| `myself.getCurrentUser` | `GET /rest/api/3/myself` | `self` must be an absolute URL (`z.url()`); `accountId` ≤ 128 chars |
| `userSearch.findUsers` | `GET /rest/api/3/user/search?query=` | array of users |
| `userSearch.findAssignableUsers` | `GET /rest/api/3/user/assignable/search?project=` | array of users |
| `users.getUser` | `GET /rest/api/3/user?accountId=` | |
| `projects.searchProjects` | `GET /rest/api/3/project/search` | Page: `isLast`, `maxResults`, `startAt`, `total`, `values` are **required**; `self`/`nextPage` must be URLs |
| `projects.getProject` | `GET /rest/api/3/project/{key}` | |
| `issueFields.getFields` | `GET /rest/api/3/field` | each `schema` needs `type` |
| `issuePriorities.searchPriorities` | `GET /rest/api/3/priority/search` | jira.js 6 has no wrapper for the older `GET /priority` (served anyway) |
| `workflowStatuses.getStatuses` | `GET /rest/api/3/status` | |
| `issueTypes.getIssueAllTypes` | `GET /rest/api/3/issuetype` | |
| `issues.getCreateIssueMetaIssueTypes` | `GET /rest/api/3/issue/createmeta/{project}/issuetypes` | |
| `issues.createIssue` (ADF description) | `POST /rest/api/3/issue` | response `{id, key, self}` all required strings |
| `issues.createIssue` (string description) | `POST /rest/api/2/issue` | no schema check on the v2 response |
| `issues.getIssue` | `GET /rest/api/3/issue/{key}[?fields=a&fields=b]` | `fields` sent as **repeated** params; `self` must be a URL |
| `issues.editIssue` | `PUT /rest/api/3/issue/{key}` | expects 204. A string description is **not** re-routed to v2: it reaches v3 and gets Jira's 400 ("Operation value must be an Atlassian Document"), as on Jira Cloud |
| `issues.assignIssue` | `PUT /rest/api/3/issue/{key}/assignee` | body `{accountId}` |
| `issues.getTransitions` | `GET /rest/api/3/issue/{key}/transitions` | |
| `issues.doTransition` | `POST /rest/api/3/issue/{key}/transitions` | body `{transition: {id}}`; expects 204 |
| `issueComments.addComment` (ADF) | `POST /rest/api/3/issue/{key}/comment` | response `body` must be an ADF doc (`type: "doc"`, `version`, `content`) |
| `issueComments.addComment` (string) | `POST /rest/api/2/issue/{key}/comment` then `GET /rest/api/3/issue/{key}/comment/{id}` | needs the single-comment GET |
| `issueComments.getComments` | `GET /rest/api/3/issue/{key}/comment` | |
| `issueSearch.searchAndReconsileIssuesUsingJql` | `GET /rest/api/3/search/jql?jql=&maxResults=&fields=&nextPageToken=` | `nextPageToken` nullish, `isLast` optional |
| `issueSearch.searchAndReconsileIssuesUsingJqlPost` | `POST /rest/api/3/search/jql` | body `{jql, maxResults, fields: [...], nextPageToken}` |
| errors | any 4xx | surfaced as `ApiError` with `status`; the message includes the Jira body |

Strict audit (`AUDIT_SCHEMAS=true`, which makes jira.js reject undocumented keys) reports a single
extra key across all these responses: `untranslatedName` on create-meta issue types (real Jira sends
it too). Everything else matches jira.js's schemas exactly.

## Python `jira` 3.10.5 (run with `uv run --with jira`)

Talks v2 (`rest_api_version` default) and reads `deploymentType == "Cloud"` from serverInfo to
switch to accountId-based users and enhanced search. Observed sequence for the smoke script:

| Step | Requests |
| --- | --- |
| `JIRA(server, basic_auth, get_server_info=True)` | `GET /rest/api/2/serverInfo` (twice) |
| `myself()` | `GET /rest/api/2/myself` |
| `projects()` | `GET /rest/api/2/project` (the plain list, not `/project/search`) |
| `project("ENG")`, `fields()` | `GET /rest/api/2/project/ENG`, `GET /rest/api/2/field` |
| `create_issue(project="ENG", issuetype={"name": "Task"}, priority={"name": …})` | `GET /project/ENG` to resolve the id, then `POST /rest/api/2/issue` with `project: {id}`, then `GET /issue/{key}` |
| `issue.update(summary=…)` | `PUT /rest/api/2/issue/{numeric id}` with `{"fields": {…}, "update": {}}` (empty `update`), then `GET /issue/{id}` |
| `transitions()` / `transition_issue(key, "To do")` | `GET …/transitions` (by name lookup), then `POST …/transitions` with `{"transition": {"id"}, "fields": {}}` (empty `fields`) |
| `add_comment` / `comments` | `POST …/comment` `{"body": "…"}`; `GET …/comment` |
| `assign_issue(key, accountId)` | `GET /rest/api/2/user/search?query=<accountId>&includeActive=True&includeInactive=False` — the accountId is used as the **query** — then `PUT /rest/api/latest/issue/{key}/assignee` (note `latest`) |
| `search_issues(jql)` / `enhanced_search_issues(jql)` on Cloud | `GET /rest/api/2/field`, then `GET /rest/api/2/search/jql?jql=&fields=*all&maxResults=` |

Changes this required (now in the router): `user/search` matches an exact accountId in `query` and
honours `includeInactive=False`; `/rest/api/latest/` is served as v2; an empty `update: {}` or
`fields: {}` is accepted.

## jira-cli and go-jira (pending)

Not installed here. `go` is available (`go install github.com/ankitpokhrel/jira-cli/cmd/jira@latest`)
but needs network access to GitHub and the Go module proxy, so they have not been run. When they
are, run them against the same local server and record the calls in this file. From their source
(unverified against this server): jira-cli's `init` reads `serverInfo` and `myself`, lists projects
and boards (the Agile API, out of scope — `init` may need `--board` skipped), and on Cloud searches
with `/rest/api/3/search/jql`; `issue create` uses create-meta and `POST /rest/api/2/issue` (wiki
markup description, stored verbatim here); `issue move` uses transitions by name; `issue assign`
uses `user/assignable/search` and `PUT …/assignee`.

## Behaviour a client may notice

- **One issue type**, `Task` (id `10001`). Creating any other type is a 400.
- **Priorities**: Highest, High, Medium, Low. `Lowest` (id 5) is accepted on input as Low and never
  returned. No priority = the `priority` field is absent.
- **Search** returns only `id`, `key` and `self` unless `fields` is given (Jira's `/search/jql`
  default). `*all`, `*navigable`, explicit ids and `-id` exclusions work. `expand`, `properties`,
  `fieldsByKeys` and `reconcileIssues` are ignored. `maxResults` is clamped to 1–100.
  Unlike Jira Cloud, unbounded JQL (no restriction) is allowed.
- **Rich text**: v2 is plain text, stored as-is (wiki markup is not converted). v3 is ADF, converted
  to and from Markdown; unsupported nodes and marks (tables, panels, underline, colour, emoji, …) are
  a 400 naming the node, never dropped.
- **Writes** are idempotent for a retried identical request within 60 s (derived key), so posting
  the same comment twice within a minute stores it once.
- **A write awaiting approval** answers 409 with `X-Records-Action-Id`; it is not reported as saved.
- **Not implemented**: the Agile API, attachments, worklogs, links, watchers, votes, labels
  (an empty `labels: []` is accepted), issue properties, comment visibility, changelog endpoints,
  most `expand` options, `DELETE` of anything.
