"""Records SDK for Python: a typed client for the Records native API, generated from its OpenAPI
document by packages/records-sdk/scripts/generate.ts. Standard library only."""

from ._generated import API_VERSION, OPERATIONS, RecordsClient
from ._runtime import (
    RecordsApiError,
    RecordsNetworkError,
    RevisionConflictError,
    retry_after_seconds,
    revision_of,
)

__all__ = [
    "API_VERSION",
    "OPERATIONS",
    "RecordsApiError",
    "RecordsClient",
    "RecordsNetworkError",
    "RevisionConflictError",
    "retry_after_seconds",
    "revision_of",
]
