// One datastore: tabs gated by the caller's role (ROLE_PERMISSIONS in @records/contracts).

import type { DatastoreDetail as Detail, DatastoreSummary } from '@records/contracts'
import { Archive, ArrowCounterClockwise, DownloadSimple } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useDataApi } from '../bridge'
import { describeError, type DisplayError } from '../errors'
import { permsFor, ROLE_LABEL, type Perms } from '../permissions'
import { AuditTab } from './tabs/AuditTab'
import { ConnectionsTab } from './tabs/ConnectionsTab'
import { CredentialsTab } from './tabs/CredentialsTab'
import { MembersTab } from './tabs/MembersTab'
import { RecordsTab } from './tabs/RecordsTab'
import { Badge, Btn, ConfirmDialog, ErrorNotice, formatDate, Loading, Notice, Tabs, useAction } from './ui'

type TabKey = 'overview' | 'members' | 'connections' | 'credentials' | 'audit' | 'records'

export type DatastoreView = DatastoreSummary | Detail

export function isDetail(d: DatastoreView): d is Detail {
  return 'owner' in d
}

export function DatastoreDetail({
  datastoreId,
  myPrincipalId,
  onChanged,
}: {
  datastoreId: string
  myPrincipalId: string
  /** The datastore's list-visible state changed (lifecycle, ownership). */
  onChanged: () => void
}) {
  const api = useDataApi()
  const [ds, setDs] = useState<DatastoreView | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [tab, setTab] = useState<TabKey>('overview')

  const load = useCallback(async () => {
    try {
      setDs(await api.getDatastore(datastoreId))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, datastoreId])

  useEffect(() => {
    setDs(null)
    setTab('overview')
    void load()
  }, [load])

  const perms = useMemo(() => permsFor(ds?.role ?? null), [ds?.role])

  if (error && !ds) return <ErrorNotice error={error} className="m-6" />
  if (!ds) return <Loading label="Loading datastore…" />

  const tabs: { key: TabKey; label: string }[] = [{ key: 'overview', label: 'Overview' }]
  if (perms.has('members.manage')) tabs.push({ key: 'members', label: 'Members' })
  if (perms.has('bindings.manage')) tabs.push({ key: 'connections', label: 'Connections' })
  if (perms.has('credentials.manage')) tabs.push({ key: 'credentials', label: 'Credentials' })
  if (perms.has('audit.read')) tabs.push({ key: 'audit', label: 'Audit' })
  if (perms.has('projects.read')) tabs.push({ key: 'records', label: 'Records' })
  const active = tabs.some((t) => t.key === tab) ? tab : 'overview'
  const archived = ds.lifecycle === 'archived'
  const refresh = () => {
    void load()
    onChanged()
  }

  return (
    <section aria-labelledby="datastore-title" className="flex h-full min-h-0 flex-col">
      <header className="px-6 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="datastore-title" className="text-[20px] font-medium tracking-[-0.4px] text-kumo-default">
            {ds.name}
          </h2>
          <Badge tone={ds.role === 'owner' ? 'brand' : 'neutral'}>{ds.role ? `Your role: ${ROLE_LABEL[ds.role]}` : 'Not a member'}</Badge>
          {archived ? <Badge tone="warning">Archived</Badge> : null}
        </div>
        {ds.description ? <p className="mt-1 text-[13px] text-kumo-subtle">{ds.description}</p> : null}
        {archived ? (
          <div className="mt-3">
            <Notice tone="warning">This datastore is archived: its records are read-only and no new credentials or projects can be created.</Notice>
          </div>
        ) : null}
        <div className="mt-4">
          <Tabs label="Datastore sections" tabs={tabs} active={active} onChange={setTab} idPrefix="ds" />
        </div>
      </header>
      <div
        role="tabpanel"
        id={`ds-panel-${active}`}
        aria-labelledby={`ds-tab-${active}`}
        tabIndex={0}
        className="ctx-scroll min-h-0 flex-1 overflow-y-auto px-6 py-5 focus-visible:outline-none"
      >
        {active === 'overview' ? <OverviewTab ds={ds} perms={perms} onChanged={refresh} /> : null}
        {active === 'members' ? <MembersTab ds={ds} perms={perms} myPrincipalId={myPrincipalId} onChanged={refresh} /> : null}
        {active === 'connections' ? <ConnectionsTab ds={ds} perms={perms} /> : null}
        {active === 'credentials' ? <CredentialsTab ds={ds} perms={perms} /> : null}
        {active === 'audit' ? <AuditTab ds={ds} /> : null}
        {active === 'records' ? <RecordsTab ds={ds} perms={perms} /> : null}
      </div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-kumo-subtle">{label}</dt>
      <dd className="text-[13px] text-kumo-default">{children}</dd>
    </div>
  )
}

function OverviewTab({ ds, perms, onChanged }: { ds: DatastoreView; perms: Perms; onChanged: () => void }) {
  const api = useDataApi()
  const exportAction = useAction()
  const [confirm, setConfirm] = useState(false)
  const [exported, setExported] = useState<string | null>(null)
  const archived = ds.lifecycle === 'archived'

  const runExport = () =>
    exportAction.run(async () => {
      const data = await api.exportDatastore(ds.id)
      const filename = `${ds.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'datastore'}-export.json`
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      if (typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      setExported(filename)
    })

  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Module">
          {ds.moduleId} (API v{ds.apiMajor}){isDetail(ds) && ds.moduleVersion ? ` · ${ds.moduleVersion}` : ''}
        </Field>
        <Field label="Status">{archived ? 'Archived (read-only)' : 'Active'}</Field>
        <Field label="Discovery">{ds.discovery === 'organisation' ? 'Whole organisation can find it' : 'Members only'}</Field>
        <Field label="Owner team">{ds.ownerTeam ?? '—'}</Field>
        <Field label="Features">{ds.features.length ? ds.features.join(', ') : '—'}</Field>
        <Field label="Created">{formatDate(ds.createdAt)}</Field>
        <Field label="Updated">{formatDate(ds.updatedAt)}</Field>
        {isDetail(ds) ? (
          <>
            <Field label="Owner">{ds.owner.displayName}</Field>
            <Field label="Retention">{ds.retentionPolicy}</Field>
            <Field label="Environment">{ds.environment}</Field>
            <Field label="Placement">{ds.placement}</Field>
            <Field label="Members">{ds.memberCount}</Field>
            <Field label="Active connections">{ds.activeBindingCount}</Field>
            <Field label="Active credentials">{ds.activeCredentialCount}</Field>
            <Field label="Revision">{ds.revision}</Field>
          </>
        ) : null}
        <Field label="ID">
          <code className="text-[12px] break-all">{ds.id}</code>
        </Field>
      </dl>

      {perms.has('export.run') || perms.has('lifecycle.manage') ? (
        <div className="flex flex-wrap gap-2 border-t border-kumo-line pt-4">
          {perms.has('export.run') ? (
            <Btn onClick={() => void runExport()} loading={exportAction.busy}>
              <DownloadSimple size={14} aria-hidden className="mr-1" />
              Export JSON
            </Btn>
          ) : null}
          {perms.has('lifecycle.manage') ? (
            <Btn tone={archived ? 'secondary' : 'danger'} onClick={() => setConfirm(true)}>
              {archived ? <ArrowCounterClockwise size={14} aria-hidden className="mr-1" /> : <Archive size={14} aria-hidden className="mr-1" />}
              {archived ? 'Restore' : 'Archive'}
            </Btn>
          ) : null}
        </div>
      ) : null}
      <ErrorNotice error={exportAction.error} />
      {exported ? <Notice tone="success">Exported {exported}.</Notice> : null}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={archived ? 'Restore datastore' : 'Archive datastore'}
        tone={archived ? 'primary' : 'danger'}
        confirmLabel={archived ? 'Restore' : 'Archive'}
        body={
          archived ? (
            <p>Restoring makes {ds.name} writable again.</p>
          ) : (
            <p>
              Archiving makes <strong>{ds.name}</strong> read-only. Gadgets and credentials can still read it; nothing can change its records until it is
              restored.
            </p>
          )
        }
        onConfirm={async () => {
          await api.setLifecycle(ds.id, archived ? 'active' : 'archived')
          onChanged()
        }}
      />
    </div>
  )
}
