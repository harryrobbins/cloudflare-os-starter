// Searchable, cursor-paginated list of the datastores the caller can see.

import type { DatastoreSummary } from '@records/contracts'
import { Archive, MagnifyingGlass } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useDataApi } from '../bridge'
import { describeError, type DisplayError } from '../errors'
import { ROLE_LABEL } from '../permissions'
import { Badge, Btn, CheckboxField, Empty, ErrorNotice, Loading, useDebounced } from './ui'

export function DatastoreList({
  selectedId,
  onSelect,
  refreshKey,
  pageSize,
}: {
  selectedId: string | null
  onSelect: (id: string) => void
  /** Bump to reload from the first page. */
  refreshKey: number
  pageSize: number
}) {
  const api = useDataApi()
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 250)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [items, setItems] = useState<DatastoreSummary[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<DisplayError | null>(null)
  // Ignore responses to superseded queries.
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    setItems(null)
    setError(null)
    api
      .searchDatastores({ query: debounced, includeArchived, limit: pageSize })
      .then((page) => {
        if (n !== seq.current) return
        setItems(page.items)
        setCursor(page.nextCursor)
      })
      .catch((err: unknown) => {
        if (n !== seq.current) return
        setItems([])
        setCursor(null)
        setError(describeError(err))
      })
  }, [api, debounced, includeArchived, pageSize, refreshKey])

  const loadMore = async () => {
    if (!cursor) return
    const n = seq.current
    setLoadingMore(true)
    try {
      const page = await api.searchDatastores({ query: debounced, includeArchived, limit: pageSize, cursor })
      if (n !== seq.current) return
      setItems((prev) => [...(prev ?? []), ...page.items])
      setCursor(page.nextCursor)
    } catch (err) {
      if (n === seq.current) setError(describeError(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <nav aria-label="Datastores" className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-kumo-line p-3">
        <div className="relative">
          <MagnifyingGlass size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-kumo-inactive" />
          <label htmlFor="datastore-search" className="sr-only">
            Search datastores
          </label>
          <input
            id="datastore-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search datastores"
            className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pr-3 pl-8 text-[13px] focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/30 focus:outline-none"
          />
        </div>
        <CheckboxField label="Include archived" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
      </div>
      <div className="ctx-scroll min-h-0 flex-1 overflow-y-auto p-2">
        <ErrorNotice error={error} className="mb-2" />
        {items === null ? (
          <Loading label="Loading datastores…" />
        ) : items.length === 0 && !error ? (
          <Empty>{debounced ? 'No datastores match.' : 'You are not a member of any datastore yet.'}</Empty>
        ) : (
          <ul className="space-y-1">
            {items.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => onSelect(d.id)}
                  aria-current={d.id === selectedId ? 'true' : undefined}
                  className={`w-full rounded-lg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-kumo-ring ${
                    d.id === selectedId ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/60'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-kumo-default">{d.name}</span>
                    <span className="flex shrink-0 gap-1">
                      {d.lifecycle === 'archived' ? (
                        <Badge tone="warning">
                          <Archive size={11} aria-hidden className="mr-0.5" />
                          Archived
                        </Badge>
                      ) : null}
                      <Badge tone={d.role === 'owner' ? 'brand' : 'neutral'}>{d.role ? ROLE_LABEL[d.role] : 'Not a member'}</Badge>
                    </span>
                  </span>
                  {d.description ? <span className="mt-0.5 block truncate text-[12px] text-kumo-subtle">{d.description}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor ? (
          <div className="mt-2 flex justify-center">
            <Btn onClick={() => void loadMore()} loading={loadingMore}>
              Load more
            </Btn>
          </div>
        ) : null}
      </div>
    </nav>
  )
}
