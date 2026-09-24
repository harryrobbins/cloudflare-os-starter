// Outbound webhooks: signed HTTPS callbacks when records change. Gated like connections
// (bindings.manage). The signing secret is returned once by createWebhook, held only in the
// dialog's component state and dropped when it closes; it is never logged or stored.

import { Copy, Warning, WebhooksLogo } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DataApi } from '../../api'
import { useDataApi } from '../../bridge'
import { describeError, type DisplayError } from '../../errors'
import type { DatastoreView } from '../DatastoreDetail'
import {
  Badge,
  Btn,
  CheckboxField,
  ConfirmDialog,
  Empty,
  ErrorNotice,
  formatDate,
  Loading,
  Modal,
  ModalFooter,
  SandboxForm,
  SectionHeader,
  SelectField,
  Table,
  TD,
  TextField,
  useAction,
} from '../ui'

type Webhook = Awaited<ReturnType<DataApi['listWebhooks']>>[number]
type Delivery = Awaited<ReturnType<DataApi['listWebhookDeliveries']>>[number]
type Format = Webhook['format']
type WebhookEvent = Webhook['events'][number]

const notice = (title: string): DisplayError => ({ code: null, title, detail: '', issues: [] })

const EVENTS: { value: WebhookEvent; label: string; jira: boolean }[] = [
  { value: 'issue.created', label: 'Issue created', jira: true },
  { value: 'issue.updated', label: 'Issue updated or moved', jira: true },
  { value: 'comment.created', label: 'Comment added', jira: true },
  { value: 'project.created', label: 'Project created', jira: false },
  { value: 'project.updated', label: 'Project updated', jira: false },
]

export function WebhooksTab({ ds }: { ds: DatastoreView }) {
  const api = useDataApi()
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<Webhook | null>(null)
  const [viewing, setViewing] = useState<Webhook | null>(null)
  const row = useAction()
  const archived = ds.lifecycle === 'archived'

  const load = useCallback(async () => {
    try {
      setHooks(await api.listWebhooks(ds.id))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, ds.id])
  useEffect(() => {
    void load()
  }, [load])

  if (error && !hooks) return <ErrorNotice error={error} />
  if (!hooks) return <Loading label="Loading webhooks…" />

  return (
    <div className="space-y-4">
      <SectionHeader title="Webhooks">
        <Btn tone="primary" disabled={archived} onClick={() => setCreating(true)}>
          <WebhooksLogo size={14} aria-hidden className="mr-1" />
          New webhook
        </Btn>
      </SectionHeader>
      <p className="text-[13px] text-kumo-subtle">
        Signed HTTPS calls to another service when records change. Each webhook sees only what its creator can read, and stops if they lose access.
      </p>
      <ErrorNotice error={row.error} />
      {hooks.length === 0 ? (
        <Empty>No webhooks yet.</Empty>
      ) : (
        <Table label="Webhooks" head={['Name', 'Destination', 'Format', 'Last success', 'Status', '']}>
          {hooks.map((h) => (
            <tr key={h.id}>
              <td className={TD}>{h.label}</td>
              <td className={`${TD} max-w-[220px] truncate text-[12px] text-kumo-subtle`} title={h.url}>
                {h.url}
              </td>
              <td className={TD}>{h.format === 'jira' ? 'Jira' : 'Records'}</td>
              <td className={`${TD} text-kumo-subtle`}>{formatDate(h.lastSuccessAt)}</td>
              <td className={TD}>
                {h.status === 'active' ? (
                  <Badge tone={h.consecutiveFailures > 0 ? 'warning' : 'success'}>{h.consecutiveFailures > 0 ? 'Failing' : 'Active'}</Badge>
                ) : (
                  <span title={h.disabledReason ?? undefined}>
                    <Badge tone="neutral">Disabled</Badge>
                  </span>
                )}
              </td>
              <td className={`${TD} whitespace-nowrap text-right`}>
                <Btn tone="ghost" onClick={() => setViewing(h)} aria-label={`Deliveries for ${h.label}`}>
                  Deliveries
                </Btn>
                {h.status === 'active' ? (
                  <Btn
                    tone="ghost"
                    disabled={row.busy}
                    aria-label={`Test ${h.label}`}
                    onClick={() =>
                      void row.run(async () => {
                        await api.pingWebhook(ds.id, h.id)
                        setViewing(h)
                      })
                    }
                  >
                    Test
                  </Btn>
                ) : null}
                <Btn
                  tone="ghost"
                  disabled={row.busy || archived}
                  aria-label={`${h.status === 'active' ? 'Disable' : 'Enable'} ${h.label}`}
                  onClick={() =>
                    void row.run(async () => {
                      await api.setWebhookEnabled(ds.id, h.id, h.status !== 'active')
                      await load()
                    })
                  }
                >
                  {h.status === 'active' ? 'Disable' : 'Enable'}
                </Btn>
                <Btn tone="ghost" onClick={() => setDeleting(h)} aria-label={`Delete ${h.label}`}>
                  Delete
                </Btn>
              </td>
            </tr>
          ))}
        </Table>
      )}
      <CreateWebhookDialog open={creating} ds={ds} onClose={() => setCreating(false)} onCreated={() => void load()} />
      <DeliveriesDialog webhook={viewing} ds={ds} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete webhook"
        confirmLabel="Delete"
        body={
          <p>
            Delete <strong>{deleting?.label}</strong>? Calls stop immediately, and undelivered changes are dropped.
          </p>
        }
        onConfirm={async () => {
          if (!deleting) return
          await api.deleteWebhook(ds.id, deleting.id)
          await load()
        }}
      />
    </div>
  )
}

function CreateWebhookDialog({ open, ds, onClose, onCreated }: { open: boolean; ds: DatastoreView; onClose: () => void; onCreated: () => void }) {
  const api = useDataApi()
  const action = useAction()
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('https://')
  const [format, setFormat] = useState<Format>('native')
  const [chosen, setChosen] = useState<Set<WebhookEvent>>(() => new Set(EVENTS.map((e) => e.value)))
  const [created, setCreated] = useState<{ label: string; secret: string } | null>(null)
  const offered = EVENTS.filter((e) => format === 'native' || e.jira)

  const close = () => {
    setCreated(null)
    setLabel('')
    setUrl('https://')
    setFormat('native')
    setChosen(new Set(EVENTS.map((e) => e.value)))
    action.setError(null)
    onClose()
  }

  const submit = async () => {
    const events = offered.map((e) => e.value).filter((e) => chosen.has(e))
    if (events.length === 0) {
      action.setError(notice('Choose at least one event.'))
      return
    }
    const result = await action.run(() => api.createWebhook(ds.id, { label: label.trim(), url: url.trim(), format, events }))
    if (result) {
      setCreated({ label: result.webhook.label, secret: result.secret })
      onCreated()
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      busy={action.busy}
      width={600}
      title={created ? 'Webhook created' : 'New webhook'}
      description={created ? undefined : `Call another service when records in ${ds.name} change.`}
    >
      {created ? (
        <SecretPanel created={created} format={format} onDone={close} />
      ) : (
        <SandboxForm className="space-y-4" onSubmit={() => void submit()}>
          <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Deploy bot" maxLength={120} autoFocus />
          <TextField
            label="Destination URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={2000}
            hint="A public https address. Private and local addresses are refused."
          />
          <SelectField
            label="Payload format"
            value={format}
            onChange={(e) => setFormat(e.target.value as Format)}
            options={[
              { value: 'native', label: 'Records (journal entries)' },
              { value: 'jira', label: 'Jira-compatible (issue and comment events)' },
            ]}
          />
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-kumo-subtle">Events</legend>
            <div className="space-y-1.5">
              {offered.map((e) => (
                <CheckboxField
                  key={e.value}
                  label={e.label}
                  description={<code>{e.value}</code>}
                  checked={chosen.has(e.value)}
                  onChange={(ev) => {
                    const next = new Set(chosen)
                    if (ev.target.checked) next.add(e.value)
                    else next.delete(e.value)
                    setChosen(next)
                  }}
                />
              ))}
            </div>
          </fieldset>
          <ErrorNotice error={action.error} />
          <ModalFooter>
            <Btn onClick={close} disabled={action.busy}>
              Cancel
            </Btn>
            <Btn tone="primary" onClick={() => void submit()} loading={action.busy}>
              Create webhook
            </Btn>
          </ModalFooter>
        </SandboxForm>
      )}
    </Modal>
  )
}

function SecretPanel({ created, format, onDone }: { created: { label: string; secret: string }; format: Format; onDone: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<DisplayError | null>(null)
  const copy = async () => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(created.secret)
      setCopied(true)
    } catch (err) {
      inputRef.current?.select()
      setCopyError({ ...describeError(err), title: 'Copy was blocked. The text is selected; press Ctrl+C or Cmd+C.', detail: '' })
    }
  }
  return (
    <div className="space-y-4">
      <div role="alert" className="flex gap-2 rounded-lg bg-kumo-warning-tint px-3 py-2 text-[13px] text-kumo-default">
        <Warning size={16} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-kumo-warning" />
        <p>
          <strong>Copy this signing secret now. It will not be shown again.</strong> The receiver uses it to check that calls came from here.
        </p>
      </div>
      <div>
        <label htmlFor="webhook-secret" className="mb-1.5 block text-[12px] font-medium text-kumo-subtle">
          {created.label}
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="webhook-secret"
            readOnly
            value={created.secret}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            autoComplete="off"
            className="h-9 min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-recessed px-3 font-mono text-[12px] text-kumo-default focus:border-kumo-ring focus:outline-none"
          />
          <Btn onClick={() => void copy()}>
            <Copy size={14} aria-hidden className="mr-1" />
            {copied ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      </div>
      <p className="text-[12px] text-kumo-subtle">
        Every call carries <code>X-Records-Signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + body)</code> and <code>X-Records-Timestamp</code>
        {format === 'jira' ? (
          <>
            , plus Jira&apos;s <code>X-Hub-Signature</code>
          </>
        ) : null}
        . Reject calls whose timestamp is more than five minutes old, and ignore repeated <code>X-Records-Delivery</code> IDs.
      </p>
      <ErrorNotice error={copyError} />
      <ModalFooter>
        <Btn tone="primary" onClick={onDone}>
          I&apos;ve stored it
        </Btn>
      </ModalFooter>
    </div>
  )
}

const STATE: Record<Delivery['state'], { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  skipped: { label: 'Not subscribed', tone: 'neutral' },
  dead: { label: 'Gave up', tone: 'danger' },
}

function DeliveriesDialog({ webhook, ds, onClose }: { webhook: Webhook | null; ds: DatastoreView; onClose: () => void }) {
  const api = useDataApi()
  const [rows, setRows] = useState<Delivery[] | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const load = useCallback(async () => {
    if (!webhook) return
    try {
      setRows(await api.listWebhookDeliveries(ds.id, webhook.id))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, ds.id, webhook])
  useEffect(() => {
    setRows(null)
    void load()
  }, [load])

  return (
    <Modal open={webhook !== null} onClose={onClose} width={640} title={`Deliveries: ${webhook?.label ?? ''}`} description="The 50 most recent. Tests and changes are sent within a minute.">
      <div className="space-y-3">
        {webhook?.status === 'disabled' && webhook.disabledReason ? <ErrorNotice error={notice(webhook.disabledReason)} /> : null}
        <ErrorNotice error={error} />
        {!rows ? (
          error ? null : <Loading label="Loading deliveries…" />
        ) : rows.length === 0 ? (
          <Empty>Nothing sent yet.</Empty>
        ) : (
          <Table label="Deliveries" head={['What', 'Created', 'Attempts', 'Result', 'Status']}>
            {rows.map((d) => (
              <tr key={d.id}>
                <td className={TD}>{d.kind === 'ping' ? 'Test' : `Change ${d.seq}`}</td>
                <td className={`${TD} text-kumo-subtle`}>{formatDate(d.createdAt)}</td>
                <td className={TD}>{d.attempts}</td>
                <td className={`${TD} text-[12px] text-kumo-subtle`}>{d.lastError ?? (d.lastStatus ? `HTTP ${d.lastStatus}` : '')}</td>
                <td className={TD}>
                  <Badge tone={STATE[d.state].tone}>{STATE[d.state].label}</Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
        <ModalFooter>
          <Btn onClick={() => void load()}>Refresh</Btn>
          <Btn tone="primary" onClick={onClose}>
            Done
          </Btn>
        </ModalFooter>
      </div>
    </Modal>
  )
}
