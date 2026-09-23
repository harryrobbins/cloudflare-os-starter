// Members: list, add, change role, remove, transfer ownership. Actions shown only where the matrix
// (canAssignRole) allows them; the server enforces the same rules.

import type { DatastoreRole, Member } from '@records/contracts'
import { useCallback, useEffect, useState } from 'react'
import type { DirectoryPerson } from '../../api'
import { useDataApi } from '../../bridge'
import { describeError, type DisplayError } from '../../errors'
import { assignableRoles, canManageMember, ROLE_LABEL, type Perms } from '../../permissions'
import type { DatastoreView } from '../DatastoreDetail'
import { PrincipalPicker } from '../PrincipalPicker'
import {
  Badge,
  Btn,
  ConfirmDialog,
  ErrorNotice,
  formatDate,
  Loading,
  Modal,
  ModalFooter,
  SectionHeader,
  SelectField,
  Table,
  TD,
  useAction,
} from '../ui'

export function MembersTab({
  ds,
  perms,
  myPrincipalId,
  onChanged,
}: {
  ds: DatastoreView
  perms: Perms
  myPrincipalId: string
  onChanged: () => void
}) {
  const api = useDataApi()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [loadError, setLoadError] = useState<DisplayError | null>(null)
  const rowAction = useAction()
  const [adding, setAdding] = useState(false)
  const [transferring, setTransferring] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)
  const myRole = perms.role
  const roles = assignableRoles(myRole)

  const load = useCallback(async () => {
    try {
      setMembers(await api.listMembers(ds.id))
      setLoadError(null)
    } catch (err) {
      setLoadError(describeError(err))
    }
  }, [api, ds.id])
  useEffect(() => {
    void load()
  }, [load])

  const changeRole = (m: Member, role: DatastoreRole) =>
    rowAction.run(async () => {
      await api.setMemberRole(ds.id, { principalId: m.principal.id, role })
      await load()
    })

  if (loadError && !members) return <ErrorNotice error={loadError} />
  if (!members) return <Loading label="Loading members…" />

  // Service principals are managed from the Credentials tab.
  const people = members.filter((m) => m.principal.kind === 'human')
  const services = members.length - people.length

  return (
    <div className="space-y-4">
      <SectionHeader title="Members">
        {perms.has('ownership.transfer') ? <Btn onClick={() => setTransferring(true)}>Transfer ownership</Btn> : null}
        {roles.length ? (
          <Btn tone="primary" onClick={() => setAdding(true)}>
            Add member
          </Btn>
        ) : null}
      </SectionHeader>
      <ErrorNotice error={rowAction.error} />
      <Table label="Members" head={['Person', 'Role', 'Since', '']}>
        {people.map((m) => {
          const manageable = canManageMember(myRole, m.role) && m.principal.id !== myPrincipalId
          return (
            <tr key={m.principal.id}>
              <td className={TD}>
                {m.principal.displayName}
                {m.principal.id === myPrincipalId ? <span className="text-kumo-subtle"> (you)</span> : null}
              </td>
              <td className={TD}>
                {manageable ? (
                  <SelectField
                    label={`Role for ${m.principal.displayName}`}
                    hideLabel
                    className="w-40"
                    value={m.role}
                    disabled={rowAction.busy}
                    onChange={(e) => void changeRole(m, e.target.value as DatastoreRole)}
                    options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                  />
                ) : (
                  <Badge tone={m.role === 'owner' ? 'brand' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                )}
              </td>
              <td className={`${TD} text-kumo-subtle`}>{formatDate(m.grantedAt)}</td>
              <td className={`${TD} text-right`}>
                {manageable ? (
                  <Btn tone="ghost" onClick={() => setRemoving(m)} aria-label={`Remove ${m.principal.displayName}`}>
                    Remove
                  </Btn>
                ) : null}
              </td>
            </tr>
          )
        })}
      </Table>
      {services ? (
        <p className="text-[12px] text-kumo-subtle">
          {services} service principal{services === 1 ? '' : 's'} (credentials) not shown; manage them under Credentials.
        </p>
      ) : null}

      <AddMemberDialog
        open={adding}
        datastoreId={ds.id}
        roles={roles}
        exclude={members.map((m) => m.principal.id)}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          void load()
        }}
      />
      <TransferDialog
        open={transferring}
        ds={ds}
        onClose={() => setTransferring(false)}
        onDone={() => {
          setTransferring(false)
          void load()
          onChanged()
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove member"
        confirmLabel="Remove"
        body={
          <p>
            Remove <strong>{removing?.principal.displayName}</strong> from {ds.name}? They lose access immediately, including through any connections they
            made.
          </p>
        }
        onConfirm={async () => {
          if (!removing) return
          await api.removeMember(ds.id, { principalId: removing.principal.id })
          await load()
        }}
      />
    </div>
  )
}

function AddMemberDialog({
  open,
  datastoreId,
  roles,
  exclude,
  onClose,
  onAdded,
}: {
  open: boolean
  datastoreId: string
  roles: DatastoreRole[]
  exclude: string[]
  onClose: () => void
  onAdded: () => void
}) {
  const api = useDataApi()
  const action = useAction()
  const [person, setPerson] = useState<DirectoryPerson | null>(null)
  const defaultRole: DatastoreRole = roles.includes('reader') ? 'reader' : roles[roles.length - 1] ?? 'reader'
  const [role, setRole] = useState<DatastoreRole>(defaultRole)
  const close = () => {
    setPerson(null)
    setRole(defaultRole)
    action.setError(null)
    onClose()
  }
  return (
    <Modal open={open} onClose={close} busy={action.busy} title="Add member">
      <PrincipalPicker label="Person" value={person} onChange={setPerson} exclude={exclude} disabled={action.busy} />
      <SelectField
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value as DatastoreRole)}
        options={roles.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
      />
      <ErrorNotice error={action.error} />
      <ModalFooter>
        <Btn onClick={close} disabled={action.busy}>
          Cancel
        </Btn>
        <Btn
          tone="primary"
          disabled={!person}
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (!person) return
              await api.addMember(datastoreId, { principalId: person.id, role })
              setPerson(null)
              onAdded()
            })
          }
        >
          Add
        </Btn>
      </ModalFooter>
    </Modal>
  )
}

function TransferDialog({ open, ds, onClose, onDone }: { open: boolean; ds: DatastoreView; onClose: () => void; onDone: () => void }) {
  const api = useDataApi()
  const action = useAction()
  const [person, setPerson] = useState<DirectoryPerson | null>(null)
  const close = () => {
    setPerson(null)
    action.setError(null)
    onClose()
  }
  return (
    <Modal
      open={open}
      onClose={close}
      busy={action.busy}
      title="Transfer ownership"
      description="The new owner becomes accountable for this datastore. You become an administrator."
    >
      <PrincipalPicker label="New owner" value={person} onChange={setPerson} disabled={action.busy} />
      <ErrorNotice error={action.error} />
      <ModalFooter>
        <Btn onClick={close} disabled={action.busy}>
          Cancel
        </Btn>
        <Btn
          tone="danger"
          disabled={!person}
          loading={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (!person) return
              await api.transferOwnership(ds.id, { newOwnerPrincipalId: person.id })
              setPerson(null)
              onDone()
            })
          }
        >
          Transfer to {person?.displayName ?? '…'}
        </Btn>
      </ModalFooter>
    </Modal>
  )
}
