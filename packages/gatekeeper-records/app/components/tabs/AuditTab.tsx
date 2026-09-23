// The datastore's audit log, newest first, cursor-paginated.

import type { AuditEvent } from '@records/contracts'
import { useEffect, useRef, useState } from 'react'
import { useDataApi } from '../../bridge'
import { describeError, type DisplayError } from '../../errors'
import type { DatastoreView } from '../DatastoreDetail'
import { Btn, Empty, ErrorNotice, formatDate, Loading, SectionHeader, Table, TD } from '../ui'

const VIA: Record<AuditEvent['via'], string> = { gadget: 'Gadget', http: 'API', management: 'Data page', system: 'System' }

export function AuditTab({ ds, pageSize = 50 }: { ds: DatastoreView; pageSize?: number }) {
  const api = useDataApi()
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const n = ++seq.current
    setEvents(null)
    api
      .listAudit(ds.id, { limit: pageSize })
      .then((page) => {
        if (n !== seq.current) return
        setEvents(page.items)
        setCursor(page.nextCursor)
        setError(null)
      })
      .catch((err: unknown) => {
        if (n !== seq.current) return
        setEvents([])
        setError(describeError(err))
      })
  }, [api, ds.id, pageSize])

  const more = async () => {
    if (!cursor) return
    const n = seq.current
    setLoadingMore(true)
    try {
      const page = await api.listAudit(ds.id, { limit: pageSize, cursor })
      if (n !== seq.current) return
      setEvents((prev) => [...(prev ?? []), ...page.items])
      setCursor(page.nextCursor)
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader title="Audit log" />
      <ErrorNotice error={error} />
      {events === null ? (
        <Loading label="Loading audit log…" />
      ) : events.length === 0 && !error ? (
        <Empty>No events yet.</Empty>
      ) : events.length ? (
        <Table label="Audit log" head={['When', 'Who', 'Via', 'What']}>
          {events.map((e) => (
            <tr key={e.id}>
              <td className={`${TD} whitespace-nowrap text-kumo-subtle`}>{formatDate(e.at)}</td>
              <td className={TD}>
                {e.actor.displayName}
                {e.initiator && e.initiator.id !== e.actor.id ? (
                  <span className="block text-[12px] text-kumo-subtle">for {e.initiator.displayName}</span>
                ) : null}
              </td>
              <td className={TD}>{VIA[e.via] ?? e.via}</td>
              <td className={TD}>
                {e.summary}
                <code className="block text-[11px] text-kumo-inactive">{e.operation}</code>
              </td>
            </tr>
          ))}
        </Table>
      ) : null}
      {cursor ? (
        <div className="flex justify-center">
          <Btn onClick={() => void more()} loading={loadingMore}>
            Load older events
          </Btn>
        </div>
      ) : null}
    </div>
  )
}
