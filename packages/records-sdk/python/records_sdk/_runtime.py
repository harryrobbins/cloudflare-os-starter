"""Transport, retries and errors for the Records Python SDK (hand-written; stdlib only).

Mirrors src/runtime.ts. The generated client (_generated.py) describes each operation; this module
decides how to call it from the operation's ``x-records-*`` extensions:

* Idempotency keys are sent automatically on keyed mutations, one per logical call, reused on
  every retry of that call (the server replays the first outcome).
* Only idempotent calls are retried: reads ("safe"), keyed mutations ("key") and sync push
  ("natural"). Retried on connection errors, 429, 502, 503 and 504, honouring Retry-After
  (seconds or an HTTP date), otherwise exponential backoff with full jitter.
* 412 raises RevisionConflictError with ``current_revision`` from the ETag; other problem
  documents raise RecordsApiError with the stable ``code``.
"""

from __future__ import annotations

import email.utils
import json
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Callable, Dict, Iterator, Mapping, Optional, Union

IfMatch = Union[int, str]

_RETRYABLE_STATUS = {429, 502, 503, 504}


class RecordsApiError(Exception):
    """A problem document from the API (or a non-JSON error response)."""

    def __init__(self, status: int, problem: Optional[Dict[str, Any]], headers: Mapping[str, str]):
        self.status = status
        self.problem = problem
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.code: str = (problem or {}).get("code") or f"http_{status}"
        detail = (problem or {}).get("detail") or (problem or {}).get("title") or f"HTTP {status}"
        super().__init__(f"{self.code}: {detail}")


class RevisionConflictError(RecordsApiError):
    """412: the record changed since it was read. ``current_revision`` comes from the ETag."""

    def __init__(self, status: int, problem: Optional[Dict[str, Any]], headers: Mapping[str, str]):
        super().__init__(status, problem, headers)
        self.current_revision: Optional[int] = revision_of(self.headers.get("etag"))


class RecordsNetworkError(Exception):
    """The request never produced a response (after retries, when the call was retryable)."""


def revision_of(etag: Optional[str]) -> Optional[int]:
    m = re.fullmatch(r'(?:W/)?"r(\d+)"', etag.strip()) if etag else None
    return int(m.group(1)) if m else None


def retry_after_seconds(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    """Retry-After as seconds: delta-seconds or an HTTP date. None when absent or malformed."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, when - (time.time() if now is None else now))


class Response:
    def __init__(self, status: int, headers: Mapping[str, str], body: bytes):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8")) if self.body else None


Transport = Callable[[str, str, Dict[str, str], Optional[bytes], float], Response]


def urllib_transport(method: str, url: str, headers: Dict[str, str], body: Optional[bytes], timeout: float) -> Response:
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as res:
            return Response(res.status, dict(res.headers.items()), res.read())
    except urllib.error.HTTPError as err:
        return Response(err.code, dict(err.headers.items()), err.read())


class BaseClient:
    def __init__(
        self,
        base_url: str,
        datastore_id: str,
        credential: str,
        *,
        access_assertion: Union[str, Callable[[], str], None] = None,
        headers: Optional[Mapping[str, str]] = None,
        max_retries: int = 3,
        base_delay: float = 0.25,
        max_delay: float = 30.0,
        timeout: float = 30.0,
        transport: Optional[Transport] = None,
        sleep: Callable[[float], None] = time.sleep,
        idempotency_key: Callable[[], str] = lambda: str(uuid.uuid4()),
    ):
        self.base_url = base_url.rstrip("/")
        self.datastore_id = datastore_id
        self._credential = credential
        self._access_assertion = access_assertion
        self._headers = dict(headers or {})
        self._max_retries = max_retries
        self._base_delay = base_delay
        self._max_delay = max_delay
        self._timeout = timeout
        self._transport = transport or urllib_transport
        self._sleep = sleep
        self._new_key = idempotency_key

    # ------------------------------------------------------------------------------------------

    def _url(self, op: Mapping[str, Any], path_params: Mapping[str, str], query: Optional[Mapping[str, Any]]) -> str:
        def fill(m: "re.Match[str]") -> str:
            name = m.group(1)
            value = self.datastore_id if name == "datastoreId" else path_params.get(name)
            if value is None:
                raise TypeError(f"missing path parameter {name}")
            return urllib.parse.quote(str(value), safe="")

        url = self.base_url + re.sub(r"\{(\w+)\}", fill, op["path"])
        params = {k: ("true" if v is True else "false" if v is False else str(v)) for k, v in (query or {}).items() if v is not None}
        return f"{url}?{urllib.parse.urlencode(params)}" if params else url

    def _backoff(self, attempt: int) -> float:
        return random.random() * min(self._max_delay, self._base_delay * (2 ** attempt))

    def _send(self, op: Mapping[str, Any], path_params: Mapping[str, str], query: Optional[Mapping[str, Any]], body: Any,
              *, if_match: Optional[IfMatch] = None, idempotency_key: Optional[str] = None) -> Response:
        url = self._url(op, path_params, query)
        headers = {"accept": "application/json", **self._headers, "authorization": f"Bearer {self._credential}"}
        assertion = self._access_assertion() if callable(self._access_assertion) else self._access_assertion
        if assertion:
            headers["cf-access-jwt-assertion"] = assertion
        if op["idempotency"] == "key":
            headers["idempotency-key"] = idempotency_key or self._new_key()
        if op["ifMatch"]:
            if if_match is None:
                raise TypeError("This operation needs if_match: the revision (or ETag) you last read.")
            headers["if-match"] = f'"r{if_match}"' if isinstance(if_match, int) else if_match
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"

        retryable = op["idempotency"] in ("safe", "key", "natural")
        attempt = 0
        while True:
            can_retry = retryable and attempt < self._max_retries
            try:
                res = self._transport(op["method"], url, headers, payload, self._timeout)
            except (OSError, urllib.error.URLError) as err:
                if not can_retry:
                    raise RecordsNetworkError(str(err)) from err
                self._sleep(self._backoff(attempt))
                attempt += 1
                continue
            if 200 <= res.status < 300:
                return res
            if can_retry and res.status in _RETRYABLE_STATUS:
                wait = retry_after_seconds(res.headers.get("retry-after"))
                self._sleep(min(wait if wait is not None else self._backoff(attempt), self._max_delay))
                attempt += 1
                continue
            raise _error_from(res)

    def _call(self, op: Mapping[str, Any], path_params: Mapping[str, str], query: Optional[Mapping[str, Any]], body: Any,
              *, if_match: Optional[IfMatch] = None, idempotency_key: Optional[str] = None) -> Any:
        return self._send(op, path_params, query, body, if_match=if_match, idempotency_key=idempotency_key).json()

    def _paginate(self, op: Mapping[str, Any], path_params: Mapping[str, str], query: Optional[Mapping[str, Any]]) -> Iterator[Any]:
        p = op["pagination"]
        q = dict(query or {})
        while True:
            page = self._call(op, path_params, q, None)
            items = page.get(p["itemsField"]) or []
            yield from items
            nxt = page.get(p["nextField"])
            if p["style"] == "cursor":
                if not nxt:
                    return
                q[p["cursorParam"]] = nxt
            else:
                if not items or nxt == q.get(p["afterParam"]):
                    return
                q[p["afterParam"]] = nxt


def _error_from(res: Response) -> RecordsApiError:
    problem = None
    try:
        parsed = res.json()
        if isinstance(parsed, dict) and isinstance(parsed.get("code"), str):
            problem = parsed
    except ValueError:
        pass
    cls = RevisionConflictError if res.status == 412 else RecordsApiError
    return cls(res.status, problem, res.headers)
