// Service credentials for the HTTP API. The secret is returned once by createCredential, held only
// in this dialog's component state, and dropped when the dialog closes. It is never logged, put in
// a URL, or written to storage.

import { CreateCredentialInputSchema, type CredentialInfo, type ServiceScope } from '@records/contracts'
import { Copy, Key, Warning } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDataApi } from '../../bridge'
import { describeError, validate, type DisplayError } from '../../errors'
import { grantableScopes, SCOPE_LABEL, type Perms } from '../../permissions'
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
  SectionHeader,
  Table,
  TD,
  TextField,
  useAction,
} from '../ui'

function status(c: CredentialInfo): { label: string; tone: 'success' | 'neutral' | 'warning' } {
  if (c.revokedAt) return { label: 'Revoked', tone: 'neutral' }
  if (new Date(c.expiresAt).getTime() <= Date.now()) return { label: 'Expired', tone: 'warning' }
  return { label: 'Active', tone: 'success' }
}

export function CredentialsTab({ ds, perms }: { ds: DatastoreView; perms: Perms }) {
  const api = useDataApi()
  const [creds, setCreds] = useState<CredentialInfo[] | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<CredentialInfo | null>(null)
  const archived = ds.lifecycle === 'archived'

  const load = useCallback(async () => {
    try {
      setCreds(await api.listCredentials(ds.id))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, ds.id])
  useEffect(() => {
    void load()
  }, [load])

  if (error && !creds) return <ErrorNotice error={error} />
  if (!creds) return <Loading label="Loading credentials…" />

  return (
    <div className="space-y-4">
      <SectionHeader title="Credentials">
        <Btn tone="primary" disabled={archived} onClick={() => setCreating(true)}>
          <Key size={14} aria-hidden className="mr-1" />
          New credential
        </Btn>
      </SectionHeader>
      <p className="text-[13px] text-kumo-subtle">
        API keys for scripts and external services. Each acts as its own service principal, limited to its scopes and to what its owner can still do.
      </p>
      {creds.length === 0 ? (
        <Empty>No credentials yet.</Empty>
      ) : (
        <Table label="Credentials" head={['Name', 'Key prefix', 'Scopes', 'Owner', 'Expires', 'Last used', 'Status', '']}>
          {creds.map((c) => {
            const s = status(c)
            return (
              <tr key={c.id}>
                <td className={TD}>{c.label}</td>
                <td className={TD}>
                  <code className="text-[12px]">{c.prefix}…</code>
                </td>
                <td className={`${TD} text-[12px] text-kumo-subtle`}>{c.scopes.join(', ')}</td>
                <td className={TD}>{c.owner.displayName}</td>
                <td className={`${TD} text-kumo-subtle`}>{formatDate(c.expiresAt)}</td>
                <td className={`${TD} text-kumo-subtle`}>{formatDate(c.lastUsedAt)}</td>
                <td className={TD}>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </td>
                <td className={`${TD} text-right`}>
                  {!c.revokedAt ? (
                    <Btn tone="ghost" onClick={() => setRevoking(c)} aria-label={`Revoke ${c.label}`}>
                      Revoke
                    </Btn>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </Table>
      )}
      <CreateCredentialDialog
        open={creating}
        ds={ds}
        scopes={grantableScopes(perms.role)}
        onClose={() => setCreating(false)}
        onCreated={() => void load()}
      />
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke credential"
        confirmLabel="Revoke"
        body={
          <p>
            Revoke <strong>{revoking?.label}</strong>? Anything using it stops working immediately.
          </p>
        }
        onConfirm={async () => {
          if (!revoking) return
          await api.revokeCredential(ds.id, revoking.id)
          await load()
        }}
      />
    </div>
  )
}

function CreateCredentialDialog({
  open,
  ds,
  scopes,
  onClose,
  onCreated,
}: {
  open: boolean
  ds: DatastoreView
  scopes: ServiceScope[]
  onClose: () => void
  onCreated: () => void
}) {
  const api = useDataApi()
  const action = useAction()
  const [label, setLabel] = useState('')
  const [chosen, setChosen] = useState<Set<ServiceScope>>(() => new Set(scopes.filter((s) => s.endsWith('.read') && s !== 'audit.read')))
  const [days, setDays] = useState('90')
  // The one-time result. Wrapped in an object; cleared on close.
  const [created, setCreated] = useState<{ label: string; prefix: string; secret: string } | null>(null)
  const [apiBase, setApiBase] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    api
      .apiBase()
      .then(setApiBase)
      .catch(() => setApiBase(null))
  }, [api, open])

  const close = () => {
    setCreated(null)
    setLabel('')
    setDays('90')
    action.setError(null)
    onClose()
  }

  const submit = async () => {
    const input = { label, scopes: scopes.filter((s) => chosen.has(s)), expiresInDays: Number(days) }
    const checked = validate(CreateCredentialInputSchema, input)
    if (!checked.ok) {
      action.setError(checked.error)
      return
    }
    const result = await action.run(() => api.createCredential(ds.id, input))
    if (result) {
      setCreated({ label: result.credential.label, prefix: result.credential.prefix, secret: result.secret })
      onCreated()
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      busy={action.busy}
      width={600}
      title={created ? 'Credential created' : 'New credential'}
      description={created ? undefined : `A service credential for ${ds.name}. It can only hold scopes you hold yourself.`}
    >
      {created ? (
        <SecretPanel created={created} datastoreId={ds.id} apiBase={apiBase} onDone={close} />
      ) : (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <TextField label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Nightly BI export" maxLength={120} autoFocus />
          <fieldset>
            <legend className="mb-1.5 text-[12px] font-medium text-kumo-subtle">Scopes</legend>
            <div className="space-y-1.5">
              {scopes.map((s) => (
                <CheckboxField
                  key={s}
                  label={SCOPE_LABEL[s]}
                  description={<code>{s}</code>}
                  checked={chosen.has(s)}
                  onChange={(e) => {
                    const next = new Set(chosen)
                    if (e.target.checked) next.add(s)
                    else next.delete(s)
                    setChosen(next)
                  }}
                />
              ))}
            </div>
          </fieldset>
          <TextField
            label="Expires after (days)"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            hint="1–365 days. Credentials always expire."
            className="w-48"
          />
          <ErrorNotice error={action.error} />
          <ModalFooter>
            <Btn onClick={close} disabled={action.busy}>
              Cancel
            </Btn>
            <Btn tone="primary" type="submit" loading={action.busy}>
              Create credential
            </Btn>
          </ModalFooter>
        </form>
      )}
    </Modal>
  )
}

function SecretPanel({
  created,
  datastoreId,
  apiBase,
  onDone,
}: {
  created: { label: string; prefix: string; secret: string }
  datastoreId: string
  apiBase: string | null
  onDone: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState<'secret' | 'curl' | null>(null)
  const [copyError, setCopyError] = useState<DisplayError | null>(null)
  const base = (apiBase ?? '<API base URL>').replace(/\/+$/, '')
  // The example reads the secret from an environment variable, so the command itself can be pasted
  // into shell history or docs safely.
  const curl = [
    `export RECORDS_TOKEN='<paste the credential>'`,
    `curl -sS "${base}/datastores/${datastoreId}/projects" \\`,
    `  -H "Authorization: Bearer $RECORDS_TOKEN" \\`,
    `  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \\`,
    `  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"`,
  ].join('\n')

  const copy = async (what: 'secret' | 'curl', text: string) => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch (err) {
      // Sandboxed frames may deny clipboard access: select the text so Ctrl/Cmd+C works.
      if (what === 'secret') inputRef.current?.select()
      setCopyError({ ...describeError(err), title: 'Copy was blocked. The text is selected; press Ctrl+C or Cmd+C.', detail: '' })
    }
  }

  return (
    <div className="space-y-4">
      <div role="alert" className="flex gap-2 rounded-lg bg-kumo-warning-tint px-3 py-2 text-[13px] text-kumo-default">
        <Warning size={16} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-kumo-warning" />
        <p>
          <strong>Copy this credential now. It will not be shown again.</strong> Store it in a secret manager. If you lose it, revoke it and create a new one.
        </p>
      </div>
      <div>
        <label htmlFor="credential-secret" className="mb-1.5 block text-[12px] font-medium text-kumo-subtle">
          {created.label}
        </label>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            id="credential-secret"
            readOnly
            value={created.secret}
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            autoComplete="off"
            className="h-9 min-w-0 flex-1 rounded-lg border border-kumo-line bg-kumo-recessed px-3 font-mono text-[12px] text-kumo-default focus:border-kumo-ring focus:outline-none"
          />
          <Btn onClick={() => void copy('secret', created.secret)}>
            <Copy size={14} aria-hidden className="mr-1" />
            {copied === 'secret' ? 'Copied' : 'Copy'}
          </Btn>
        </div>
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-[12px] font-medium text-kumo-subtle">Try it</p>
          <Btn tone="ghost" onClick={() => void copy('curl', curl)}>
            {copied === 'curl' ? 'Copied' : 'Copy example'}
          </Btn>
        </div>
        <pre aria-label="Example request" className="ctx-scroll overflow-x-auto rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-[12px]">
          <code>{curl}</code>
        </pre>
        <p className="mt-1 text-[12px] text-kumo-subtle">
          The API also needs a Cloudflare Access service token for its own application; ask a platform administrator for one.
        </p>
      </div>
      <ErrorNotice error={copyError} />
      <ModalFooter>
        <Btn tone="primary" onClick={onDone}>
          I&apos;ve stored it
        </Btn>
      </ModalFooter>
    </div>
  )
}
