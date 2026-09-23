// Connections (bindings): gadgets and services connected to this datastore. Revocable.

import type { Binding } from '@records/contracts'
import { useCallback, useEffect, useState } from 'react'
import { useDataApi } from '../../bridge'
import { describeError, type DisplayError } from '../../errors'
import type { Perms } from '../../permissions'
import type { DatastoreView } from '../DatastoreDetail'
import { Badge, Btn, ConfirmDialog, Empty, ErrorNotice, formatDate, Loading, SectionHeader, Table, TD } from '../ui'

export function ConnectionsTab({ ds, perms }: { ds: DatastoreView; perms: Perms }) {
  const api = useDataApi()
  const [bindings, setBindings] = useState<Binding[] | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [revoking, setRevoking] = useState<Binding | null>(null)

  const load = useCallback(async () => {
    try {
      setBindings(await api.listBindings(ds.id))
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, ds.id])
  useEffect(() => {
    void load()
  }, [load])

  if (error && !bindings) return <ErrorNotice error={error} />
  if (!bindings) return <Loading label="Loading connections…" />

  return (
    <div className="space-y-4">
      <SectionHeader title="Connections" />
      <p className="text-[13px] text-kumo-subtle">
        Gadgets and service credentials that can reach this datastore. Each acts within its scopes and its owner&apos;s current role.
      </p>
      {bindings.length === 0 ? (
        <Empty>Nothing is connected yet.</Empty>
      ) : (
        <Table label="Connections" head={['Name', 'Kind', 'Acts as', 'Scopes', 'Status', 'Created', '']}>
          {bindings.map((b) => (
            <tr key={b.id}>
              <td className={TD}>{b.label}</td>
              <td className={TD}>{b.kind === 'gadget' ? 'Gadget' : 'Service'}</td>
              <td className={TD}>{b.principal.displayName}</td>
              <td className={`${TD} text-[12px] text-kumo-subtle`}>{b.scopes.join(', ')}</td>
              <td className={TD}>{b.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Revoked {formatDate(b.revokedAt)}</Badge>}</td>
              <td className={`${TD} text-kumo-subtle`}>{formatDate(b.createdAt)}</td>
              <td className={`${TD} text-right`}>
                {b.status === 'active' && perms.has('bindings.manage') ? (
                  <Btn tone="ghost" onClick={() => setRevoking(b)} aria-label={`Revoke ${b.label}`}>
                    Revoke
                  </Btn>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke connection"
        confirmLabel="Revoke"
        body={
          <p>
            Revoke <strong>{revoking?.label}</strong>? It stops working immediately and cannot be re-enabled.
          </p>
        }
        onConfirm={async () => {
          if (!revoking) return
          await api.revokeBinding(revoking.id)
          await load()
        }}
      />
    </div>
  )
}
