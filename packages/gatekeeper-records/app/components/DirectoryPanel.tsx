// The organisation directory, for data administrators: invite people and grant or revoke the data
// administrator role.

import { useCallback, useEffect, useState } from 'react'
import { InvitePrincipalInputSchema } from '@records/contracts'
import type { DirectoryPerson, Whoami } from '../api'
import { useDataApi } from '../bridge'
import { validate } from '../errors'
import { PrincipalPicker } from './PrincipalPicker'
import { Btn, ConfirmDialog, ErrorNotice, Notice, SectionHeader, TextField, useAction, SandboxForm } from './ui'

const InviteSchema = InvitePrincipalInputSchema

export function DirectoryPanel({ me, onMeChanged }: { me: Whoami; onMeChanged: () => void }) {
  return (
    <section aria-labelledby="directory-title" className="ctx-scroll h-full space-y-8 overflow-y-auto px-6 py-5">
      <div>
        <h2 id="directory-title" className="text-[20px] font-medium tracking-[-0.4px] text-kumo-default">
          Directory
        </h2>
        <p className="mt-1 text-[13px] text-kumo-subtle">
          People who can be given access to datastores. Data administrators create datastores and assign owners; the role gives no access to records.
        </p>
      </div>
      <InviteForm />
      <DataAdminForm me={me} onMeChanged={onMeChanged} />
    </section>
  )
}

function InviteForm() {
  const api = useDataApi()
  const action = useAction()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [added, setAdded] = useState<string | null>(null)
  const submit = async () => {
    setAdded(null)
    const input = { email: email.trim(), displayName }
    const checked = validate(InviteSchema, input)
    if (!checked.ok) {
      action.setError(checked.error)
      return
    }
    const person = await action.run(() => api.invitePrincipal(input))
    if (person) {
      setAdded(person.displayName)
      setEmail('')
      setDisplayName('')
    }
  }
  return (
    <SandboxForm className="max-w-xl space-y-3" onSubmit={() => void submit()}>
      <SectionHeader title="Add a person" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" hint="The address they sign in to the Workshop with." />
        <TextField label="Name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />
      </div>
      <ErrorNotice error={action.error} />
      {added ? <Notice tone="success">Added {added} to the directory.</Notice> : null}
      <Btn tone="primary" onClick={() => void submit()} loading={action.busy}>
        Add person
      </Btn>
    </SandboxForm>
  )
}

function DataAdminForm({ me, onMeChanged }: { me: Whoami; onMeChanged: () => void }) {
  const api = useDataApi()
  const action = useAction()
  const [person, setPerson] = useState<DirectoryPerson | null>(null)
  const [pending, setPending] = useState<boolean | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [admins, setAdmins] = useState<{ id: string; displayName: string }[] | null>(null)
  const isMe = person?.id === me.principal.id
  const isAdmin = !!person && !!admins?.some((a) => a.id === person.id)

  const loadAdmins = useCallback(() => {
    void action.run(() => api.listDataAdmins()).then((list) => {
      if (list) setAdmins(list)
    })
  }, [api])
  useEffect(loadAdmins, [loadAdmins])

  const apply = async (enabled: boolean) => {
    if (!person) return
    await api.setDataAdmin({ principalId: person.id, enabled })
    setDone(`${person.displayName} ${enabled ? 'is now' : 'is no longer'} a data administrator.`)
    loadAdmins()
    if (isMe) onMeChanged()
  }

  return (
    <div className="max-w-xl space-y-3">
      <SectionHeader title="Data administrators" />
      <p className="text-[13px] text-kumo-subtle">
        Choose a person, then grant or revoke the role. The organisation always keeps at least one data administrator.
      </p>
      <PrincipalPicker
        label="Person"
        value={person}
        onChange={(p) => {
          setPerson(p)
          setDone(null)
        }}
      />
      {admins ? (
        <p className="text-[13px] text-kumo-subtle">
          Current: {admins.map((a) => a.displayName).join(', ') || 'none'}
        </p>
      ) : null}
      {person && admins ? (
        <div className="flex flex-wrap gap-2">
          {isAdmin ? (
            <Btn tone="danger" onClick={() => setPending(false)}>
              Remove data administrator
            </Btn>
          ) : (
            <Btn tone="primary" onClick={() => setPending(true)}>
              Make data administrator
            </Btn>
          )}
        </div>
      ) : null}
      <ErrorNotice error={action.error} />
      {done ? <Notice tone="success">{done}</Notice> : null}
      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title={pending ? 'Grant data administrator' : 'Revoke data administrator'}
        tone={pending ? 'primary' : 'danger'}
        confirmLabel={pending ? 'Grant' : 'Revoke'}
        body={
          <p>
            {pending
              ? `${person?.displayName} will be able to create datastores and assign owners. This does not give access to any records.`
              : `${person?.displayName}${isMe ? ' (you)' : ''} will no longer be able to create datastores or manage the directory.`}
          </p>
        }
        onConfirm={() => apply(pending === true)}
      />
    </div>
  )
}
