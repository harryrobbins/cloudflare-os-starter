// The Data page: datastore list on the left, the selected datastore (or the directory) on the right.

import type { DatastoreSummary } from '@records/contracts'
import { AddressBook, Database, Plus } from '@phosphor-icons/react'
import { useCallback, useEffect, useState } from 'react'
import type { DirectoryPerson, Whoami } from './api'
import { useDataApi } from './bridge'
import { CreateDatastoreDialog } from './components/CreateDatastoreDialog'
import { DatastoreDetail } from './components/DatastoreDetail'
import { DatastoreList } from './components/DatastoreList'
import { DirectoryPanel } from './components/DirectoryPanel'
import { Badge, Btn, Empty, ErrorNotice, Loading, Notice } from './components/ui'
import { describeError, type DisplayError } from './errors'

type View = { kind: 'datastore'; id: string } | { kind: 'directory' } | { kind: 'none' }

export default function App({ pageSize = 25 }: { pageSize?: number }) {
  const api = useDataApi()
  const [me, setMe] = useState<Whoami | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [view, setView] = useState<View>({ kind: 'none' })
  const [refreshKey, setRefreshKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.whoami())
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api])
  useEffect(() => {
    void loadMe()
  }, [loadMe])

  if (error && !me) {
    return (
      <main className="p-6">
        <ErrorNotice error={error} />
      </main>
    )
  }
  if (!me) return <Loading label="Signing you in…" />

  const onCreated = (created: DatastoreSummary, owner: DirectoryPerson) => {
    setCreating(false)
    setRefreshKey((k) => k + 1)
    if (created.role) {
      setNotice(null)
      setView({ kind: 'datastore', id: created.id })
    } else {
      setNotice(`Created ${created.name}, owned by ${owner.displayName}. You are not a member, so it does not appear in your list.`)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Database size={20} aria-hidden className="text-kumo-brand" />
          <h1 className="text-[16px] font-medium text-kumo-default">Data</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-kumo-subtle">{me.principal.displayName}</span>
          {me.dataAdmin ? <Badge tone="brand">Data administrator</Badge> : null}
          {me.dataAdmin ? (
            <>
              <Btn
                tone={view.kind === 'directory' ? 'secondary' : 'ghost'}
                aria-pressed={view.kind === 'directory'}
                onClick={() => setView(view.kind === 'directory' ? { kind: 'none' } : { kind: 'directory' })}
              >
                <AddressBook size={14} aria-hidden className="mr-1" />
                Directory
              </Btn>
              <Btn tone="primary" onClick={() => setCreating(true)}>
                <Plus size={14} aria-hidden className="mr-1" />
                New datastore
              </Btn>
            </>
          ) : null}
        </div>
      </header>
      {notice ? (
        <div className="border-b border-kumo-line px-4 py-2">
          <Notice tone="success">{notice}</Notice>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 border-r border-kumo-line bg-kumo-elevated">
          <DatastoreList
            selectedId={view.kind === 'datastore' ? view.id : null}
            onSelect={(id) => {
              setNotice(null)
              setView({ kind: 'datastore', id })
            }}
            refreshKey={refreshKey}
            pageSize={pageSize}
          />
        </aside>
        <main className="min-w-0 flex-1">
          {view.kind === 'datastore' ? (
            <DatastoreDetail
              key={view.id}
              datastoreId={view.id}
              myPrincipalId={me.principal.id}
              onChanged={() => setRefreshKey((k) => k + 1)}
            />
          ) : view.kind === 'directory' && me.dataAdmin ? (
            <DirectoryPanel me={me} onMeChanged={() => void loadMe()} />
          ) : (
            <Empty>Choose a datastore to see its members, connections, credentials and records.</Empty>
          )}
        </main>
      </div>
      <CreateDatastoreDialog open={creating} me={me} onClose={() => setCreating(false)} onCreated={onCreated} />
    </div>
  )
}
