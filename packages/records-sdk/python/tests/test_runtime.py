"""Retry, idempotency and error behaviour of the Python runtime, with a scripted transport."""

import json
import unittest

from records_sdk import RecordsApiError, RecordsClient, RecordsNetworkError, RevisionConflictError, retry_after_seconds, revision_of
from records_sdk._runtime import Response

DS = "0190c1a2-0000-7000-8000-000000000001"


def problem(status, code, headers=None):
    return Response(status, {"content-type": "application/problem+json", **(headers or {})},
                    json.dumps({"type": "x", "title": code, "status": status, "code": code}).encode())


def ok(body, status=200, headers=None):
    return Response(status, {"content-type": "application/json", **(headers or {})}, json.dumps(body).encode())


class Scripted:
    def __init__(self, responses):
        self.responses = list(responses)
        self.seen = []
        self.sleeps = []

    def transport(self, method, url, headers, body, timeout):
        self.seen.append({"method": method, "url": url, "headers": dict(headers), "body": body})
        nxt = self.responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def client(self):
        return RecordsClient("https://records.test/", DS, "rk1_test", access_assertion="assertion", base_delay=0.1,
                             transport=self.transport, sleep=self.sleeps.append)


class RuntimeTest(unittest.TestCase):
    def test_idempotency_key_reused_across_retries_and_retry_after(self):
        s = Scripted([problem(503, "unavailable", {"Retry-After": "2"}), ok({"id": "i", "revision": 1}, 201)])
        s.client().create_issue({"projectId": "p", "title": "t"})
        self.assertEqual(len(s.seen), 2)
        h0, h1 = s.seen[0]["headers"], s.seen[1]["headers"]
        self.assertEqual(h0["authorization"], "Bearer rk1_test")
        self.assertEqual(h0["cf-access-jwt-assertion"], "assertion")
        self.assertRegex(h0["idempotency-key"], r"^[0-9a-f-]{36}$")
        self.assertEqual(h0["idempotency-key"], h1["idempotency-key"])
        self.assertEqual(s.seen[0]["url"], f"https://records.test/gatekeeper/records/v1/datastores/{DS}/issues")
        self.assertEqual(s.sleeps, [2.0])

    def test_reads_retry_on_429_and_network_errors(self):
        s = Scripted([problem(429, "rate_limited", {"Retry-After": "1"}), ConnectionResetError("reset"), ok({"items": [], "nextCursor": None})])
        s.client().list_issues(q="x", limit=5, project_id=None)
        self.assertEqual(len(s.seen), 3)
        self.assertTrue(s.seen[0]["url"].endswith("?q=x&limit=5"))
        self.assertEqual(s.sleeps[0], 1.0)
        self.assertLessEqual(s.sleeps[1], 0.2)

    def test_gives_up_after_max_retries(self):
        s = Scripted([problem(503, "unavailable")] * 4)
        with self.assertRaises(RecordsApiError) as ctx:
            s.client().get_workflow()
        self.assertEqual(ctx.exception.code, "unavailable")
        self.assertEqual(len(s.seen), 4)
        n = Scripted([OSError("down")] * 4)
        with self.assertRaises(RecordsNetworkError):
            n.client().get_workflow()

    def test_never_retries_final_errors(self):
        for status, code in [(409, "workflow_conflict"), (400, "validation_failed"), (403, "forbidden"), (500, "internal")]:
            s = Scripted([problem(status, code)])
            with self.assertRaises(RecordsApiError) as ctx:
                s.client().add_comment("c", {"body": "b"})
            self.assertEqual((ctx.exception.status, ctx.exception.code), (status, code))
            self.assertEqual(len(s.seen), 1)

    def test_if_match_and_412(self):
        s = Scripted([problem(412, "revision_conflict", {"ETag": '"r7"'})])
        with self.assertRaises(RevisionConflictError) as ctx:
            s.client().edit_issue("i", {"title": "x"}, if_match=3, idempotency_key="fixed-key-1")
        self.assertEqual(ctx.exception.current_revision, 7)
        self.assertEqual(s.seen[0]["headers"]["if-match"], '"r3"')
        self.assertEqual(s.seen[0]["headers"]["idempotency-key"], "fixed-key-1")
        self.assertEqual(s.seen[0]["method"], "PATCH")
        with self.assertRaises(TypeError):
            s.client().edit_issue("i", {"title": "x"})  # type: ignore[call-arg]

    def test_parsers(self):
        self.assertEqual(retry_after_seconds("Fri, 25 Sep 2026 00:00:05 GMT", now=1790294400.0), 5.0)
        self.assertIsNone(retry_after_seconds("soon"))
        self.assertEqual(revision_of('W/"r12"'), 12)
        self.assertIsNone(revision_of("nope"))


if __name__ == "__main__":
    unittest.main()
