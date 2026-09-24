// Admins only: the index's health and a way to re-queue chunks whose embedding never landed.

import { ArrowClockwise } from "@phosphor-icons/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { IndexStats } from "../contract.js";
import { isAbort, type SearchApi } from "../api/client.js";
import { formatCount } from "../lib/format.js";
import { ErrorNotice } from "./ErrorNotice.js";
import { sourceLabel } from "./SourceBadge.js";

export function AdminPanel({ api }: { api: SearchApi }): ReactNode {
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [requeue, setRequeue] = useState<{ busy: boolean; message: string | null; error: unknown }>({
    busy: false,
    message: null,
    error: null,
  });

  const load = useCallback(
    (signal?: AbortSignal) => {
      setError(null);
      api
        .stats(signal)
        .then(setStats)
        .catch((cause: unknown) => {
          if (!isAbort(cause)) setError(cause);
        });
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onRequeue(): Promise<void> {
    setRequeue({ busy: true, message: null, error: null });
    try {
      const queued = await api.requeue();
      setRequeue({
        busy: false,
        message: queued === 0 ? "Nothing was pending." : `Re-queued ${formatCount(queued)} ${queued === 1 ? "chunk" : "chunks"}.`,
        error: null,
      });
      load();
    } catch (cause) {
      setRequeue({ busy: false, message: null, error: cause });
    }
  }

  const figures: [string, number][] =
    stats === null
      ? []
      : [
          ["Documents", stats.documents],
          ["Chunks", stats.chunks],
          ["Pending embeddings", stats.pendingEmbeds],
          ["Deleted", stats.deletedDocuments],
          ["Tombstones", stats.tombstones],
          ["Scopes", stats.scopes],
          ["Principals", stats.principals],
        ];

  return (
    <section aria-labelledby="admin-heading" className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="admin-heading" className="text-sm font-semibold text-strong">
          Index
        </h2>
        <button
          type="button"
          onClick={() => void onRequeue()}
          disabled={requeue.busy || stats === null}
          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-control px-2.5 py-1 text-xs font-medium text-fg hover:border-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          <ArrowClockwise size={13} aria-hidden="true" className={requeue.busy ? "animate-spin" : ""} />
          Re-queue pending embeddings
        </button>
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorNotice error={error} compact onRetry={() => load()} />
        </div>
      )}
      {stats === null && error === null && <div className="skeleton mt-3 h-16" aria-label="Loading index stats" />}
      {stats !== null && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
            {figures.map(([label, value]) => (
              <div key={label} className="rounded-lg bg-tint px-3 py-2">
                <dt className="text-[11px] text-muted">{label}</dt>
                <dd className={`text-lg font-semibold tabular-nums ${label === "Pending embeddings" && value > 0 ? "text-warn" : "text-strong"}`}>
                  {formatCount(value)}
                </dd>
              </div>
            ))}
          </dl>
          {stats.bySource.length > 0 && (
            <p className="mt-2 text-xs text-muted">
              {stats.bySource.map((row) => `${sourceLabel(row.source)}: ${formatCount(row.documents)}`).join(" · ")}
            </p>
          )}
        </>
      )}
      <div aria-live="polite" className="mt-2 text-xs">
        {requeue.message !== null && <p className="text-ok">{requeue.message}</p>}
      </div>
      {requeue.error !== null && <ErrorNotice error={requeue.error} compact />}
    </section>
  );
}
