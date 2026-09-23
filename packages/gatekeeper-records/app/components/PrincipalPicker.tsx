// Pick a person from the organisation directory (searchPrincipals: active humans, at most 20).

import { MagnifyingGlass, User } from '@phosphor-icons/react'
import { useEffect, useId, useRef, useState } from 'react'
import type { DirectoryPerson } from '../api'
import { useDataApi } from '../bridge'
import { describeError, type DisplayError } from '../errors'
import { Btn, ErrorNotice, useDebounced } from './ui'

export function PrincipalPicker({
  label,
  value,
  onChange,
  exclude = [],
  disabled,
}: {
  label: string
  value: DirectoryPerson | null
  onChange: (person: DirectoryPerson | null) => void
  /** Principal IDs not to offer (e.g. existing members). */
  exclude?: string[]
  disabled?: boolean
}) {
  const api = useDataApi()
  const id = useId()
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query, 200)
  const [results, setResults] = useState<DirectoryPerson[] | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    if (value) return
    const n = ++seq.current
    api
      .searchPrincipals({ query: debounced })
      .then((people) => {
        if (n === seq.current) {
          setResults(people)
          setError(null)
        }
      })
      .catch((err: unknown) => {
        if (n === seq.current) setError(describeError(err))
      })
  }, [api, debounced, value])

  if (value) {
    return (
      <div>
        <p className="mb-1.5 text-[12px] font-medium text-kumo-subtle">{label}</p>
        <div className="flex items-center justify-between gap-2 rounded-lg border border-kumo-line px-3 py-2 text-[13px]">
          <span className="flex min-w-0 items-center gap-2">
            <User size={16} aria-hidden className="text-kumo-subtle" />
            <span className="truncate">
              <span className="font-medium">{value.displayName}</span>
              {value.email ? <span className="text-kumo-subtle"> · {value.email}</span> : null}
            </span>
          </span>
          <Btn tone="ghost" disabled={disabled} onClick={() => onChange(null)} aria-label={`Change ${label.toLowerCase()}`}>
            Change
          </Btn>
        </div>
      </div>
    )
  }

  const shown = (results ?? []).filter((p) => !exclude.includes(p.id))
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[12px] font-medium text-kumo-subtle">
        {label}
      </label>
      <div className="relative">
        <MagnifyingGlass size={14} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-kumo-inactive" />
        <input
          id={id}
          type="search"
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or e-mail"
          aria-controls={`${id}-results`}
          className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pr-3 pl-8 text-[13px] focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/30 focus:outline-none"
        />
      </div>
      <ErrorNotice error={error} className="mt-2" />
      <ul id={`${id}-results`} aria-label={`${label} results`} className="ctx-scroll mt-1 max-h-48 overflow-y-auto">
        {results && shown.length === 0 ? <li className="px-3 py-2 text-[13px] text-kumo-subtle">No matching people.</li> : null}
        {shown.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(p)}
              className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-kumo-tint focus-visible:bg-kumo-tint focus-visible:outline-none"
            >
              <span className="font-medium">{p.displayName}</span>
              {p.email ? <span className="truncate text-kumo-subtle">{p.email}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
