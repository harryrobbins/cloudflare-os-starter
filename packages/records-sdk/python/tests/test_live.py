"""The Python SDK against a running Records server. Started by __tests__/python.test.ts, which runs
a Node server over an embedded Postgres and passes its coordinates in RECORDS_TEST_* variables."""

import os
import unittest
import uuid

from records_sdk import RecordsApiError, RecordsClient, RevisionConflictError

ENV = {k: os.environ.get(f"RECORDS_TEST_{k}") for k in ("BASE_URL", "DATASTORE_ID", "PROJECT_ID", "CREDENTIAL", "READONLY_CREDENTIAL", "ACCESS_ASSERTION")}


@unittest.skipUnless(ENV["BASE_URL"], "RECORDS_TEST_BASE_URL not set (run through __tests__/python.test.ts)")
class LiveTest(unittest.TestCase):
    def setUp(self):
        self.client = RecordsClient(ENV["BASE_URL"], ENV["DATASTORE_ID"], ENV["CREDENTIAL"], access_assertion=ENV["ACCESS_ASSERTION"])
        self.project = ENV["PROJECT_ID"]

    def test_reads(self):
        self.assertEqual(self.client.get_datastore()["id"], ENV["DATASTORE_ID"])
        self.assertIn(self.project, [p["id"] for p in self.client.list_projects()["items"]])
        self.assertGreater(len(self.client.get_workflow()["states"]), 1)

    def test_create_idempotency(self):
        a = self.client.create_issue({"projectId": self.project, "title": "py one"})
        b = self.client.create_issue({"projectId": self.project, "title": "py one"})
        self.assertNotEqual(a["id"], b["id"])
        key = f"py-{uuid.uuid4()}"
        first = self.client.create_issue({"projectId": self.project, "title": "py keyed"}, idempotency_key=key)
        again = self.client.create_issue({"projectId": self.project, "title": "py keyed"}, idempotency_key=key)
        self.assertEqual(first["id"], again["id"])
        with self.assertRaises(RecordsApiError) as ctx:
            self.client.create_issue({"projectId": self.project, "title": "other"}, idempotency_key=key)
        self.assertEqual(ctx.exception.code, "idempotency_conflict")

    def test_edit_conflict_transition_comment_history(self):
        issue = self.client.create_issue({"projectId": self.project, "title": "py edit", "state": "backlog"})
        edited = self.client.edit_issue(issue["id"], {"title": "py edited"}, if_match=issue["revision"])
        self.assertEqual(edited["revision"], 2)
        with self.assertRaises(RevisionConflictError) as ctx:
            self.client.edit_issue(issue["id"], {"title": "stale"}, if_match=1)
        self.assertEqual(ctx.exception.current_revision, 2)
        moved = self.client.transition_issue(issue["id"], {"toState": "todo"}, if_match=f'"r{edited["revision"]}"')
        self.assertEqual(moved["state"], "todo")
        with self.assertRaises(RecordsApiError) as ctx:
            self.client.transition_issue(issue["id"], {"toState": "done"}, if_match=moved["revision"])
        self.assertEqual(ctx.exception.code, "workflow_conflict")
        comment = self.client.add_comment(issue["id"], {"body": "from python"})
        self.assertEqual([c["id"] for c in self.client.iterate_comments(issue["id"], limit=1)], [comment["id"]])
        ops = [(e["op"], e["entityRev"]) for e in self.client.get_issue_history(issue["id"])["items"]]
        self.assertEqual(ops, [("create", 1), ("update", 2), ("update", 3)])

    def test_iterators(self):
        marker = f"py-page-{uuid.uuid4().hex[:8]}"
        for i in (1, 2, 3):
            self.client.create_issue({"projectId": self.project, "title": f"{marker} {i}"})
        titles = [i["title"] for i in self.client.iterate_issues(q=marker, limit=2, order="number_asc")]
        self.assertEqual(titles, [f"{marker} {i}" for i in (1, 2, 3)])
        head = self.client.list_changes(after=0, limit=1)["head"]
        created = self.client.create_issue({"projectId": self.project, "title": "py change"})
        entries = list(self.client.iterate_changes(after=head, limit=1))
        self.assertTrue(any(e["entityId"] == created["id"] and e["op"] == "create" for e in entries))

    def test_sync(self):
        group, client_id, issue_id = f"grp_{uuid.uuid4().hex}", f"cli_{uuid.uuid4().hex}", str(uuid.uuid4())
        pushed = self.client.sync_push({"clientGroupId": group, "clientId": client_id, "mutations": [
            {"id": 1, "name": "projects.createIssue", "args": {"id": issue_id, "projectId": self.project, "title": "py sync"}}]})
        self.assertEqual(pushed["outcomes"][0]["status"], "applied")
        pulled = self.client.sync_pull({"clientGroupId": group, "cookie": None})
        self.assertEqual(pulled["lastMutationIdChanges"][client_id], 1)
        self.assertTrue(any(p["op"] == "put" and p["key"] == f"issue/{issue_id}" for p in pulled["patch"]))

    def test_problem_codes(self):
        read_only = RecordsClient(ENV["BASE_URL"], ENV["DATASTORE_ID"], ENV["READONLY_CREDENTIAL"], access_assertion=ENV["ACCESS_ASSERTION"])
        with self.assertRaises(RecordsApiError) as ctx:
            read_only.create_issue({"projectId": self.project, "title": "no"})
        self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "forbidden"))
        with self.assertRaises(RecordsApiError) as ctx:
            self.client.get_issue(str(uuid.uuid4()))
        self.assertEqual(ctx.exception.code, "not_found")
        with self.assertRaises(RecordsApiError) as ctx:
            self.client.create_issue({"projectId": self.project, "title": ""})
        self.assertEqual(ctx.exception.problem["issues"][0]["path"], "title")


if __name__ == "__main__":
    unittest.main()
