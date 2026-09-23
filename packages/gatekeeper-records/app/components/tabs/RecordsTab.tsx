// Read-only record inspector: projects and a filterable issue table. Business edits happen through
// module operations in gadgets, not here; administrators can create projects.

import { CreateProjectInputSchema, type Issue, type Project, type Workflow } from '@records/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDataApi } from '../../bridge'
import { describeError, validate, type DisplayError } from '../../errors'
import type { Perms } from '../../permissions'
import type { DatastoreView } from '../DatastoreDetail'
import {
  Btn,
  Empty,
  ErrorNotice,
  formatDate,
  Loading,
  Modal,
  ModalFooter,
  SectionHeader,
  SelectField,
  Table,
  TD,
  TextAreaField,
  TextField,
  useAction,
  useDebounced,
} from '../ui'

export function RecordsTab({ ds, perms, pageSize = 50 }: { ds: DatastoreView; perms: Perms; pageSize?: number }) {
  const api = useDataApi()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [error, setError] = useState<DisplayError | null>(null)
  const [creating, setCreating] = useState(false)

  const [projectId, setProjectId] = useState('')
  const [state, setState] = useState('')
  const [query, setQuery] = useState('')
  const debounced = useDebounced(query.trim(), 250)
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [issueError, setIssueError] = useState<DisplayError | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const seq = useRef(0)

  const loadProjects = useCallback(async () => {
    try {
      const [p, w] = await Promise.all([api.listProjects(ds.id), api.getWorkflow(ds.id)])
      setProjects(p)
      setWorkflow(w)
      setError(null)
    } catch (err) {
      setError(describeError(err))
    }
  }, [api, ds.id])
  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const filter = useCallback(
    (cursorArg?: string) => ({
      ...(projectId ? { projectId } : {}),
      ...(state ? { state } : {}),
      ...(debounced ? { query: debounced } : {}),
      limit: pageSize,
      ...(cursorArg ? { cursor: cursorArg } : {}),
    }),
    [projectId, state, debounced, pageSize],
  )

  const canReadIssues = perms.has('issues.read')
  useEffect(() => {
    if (!canReadIssues) return
    const n = ++seq.current
    setIssues(null)
    api
      .listIssues(ds.id, filter())
      .then((page) => {
        if (n !== seq.current) return
        setIssues(page.items)
        setCursor(page.nextCursor)
        setIssueError(null)
      })
      .catch((err: unknown) => {
        if (n !== seq.current) return
        setIssues([])
        setCursor(null)
        setIssueError(describeError(err))
      })
  }, [api, ds.id, filter, canReadIssues])

  const more = async () => {
    if (!cursor) return
    const n = seq.current
    setLoadingMore(true)
    try {
      const page = await api.listIssues(ds.id, filter(cursor))
      if (n !== seq.current) return
      setIssues((prev) => [...(prev ?? []), ...page.items])
      setCursor(page.nextCursor)
    } catch (err) {
      setIssueError(describeError(err))
    } finally {
      setLoadingMore(false)
    }
  }

  if (error && !projects) return <ErrorNotice error={error} />
  if (!projects || !workflow) return <Loading label="Loading records…" />

  const stateName = new Map(workflow.states.map((s) => [s.key, s.name]))
  const projectKey = new Map(projects.map((p) => [p.id, p.key]))
  const canCreate = perms.has('projects.manage') && ds.lifecycle === 'active'

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeader title="Projects">
          {canCreate ? (
            <Btn tone="primary" onClick={() => setCreating(true)}>
              New project
            </Btn>
          ) : null}
        </SectionHeader>
        {projects.length === 0 ? (
          <Empty>No projects yet.</Empty>
        ) : (
          <Table label="Projects" head={['Key', 'Name', 'Description', 'Updated']}>
            {projects.map((p) => (
              <tr key={p.id}>
                <td className={TD}>
                  <code>{p.key}</code>
                </td>
                <td className={TD}>{p.name}</td>
                <td className={`${TD} text-kumo-subtle`}>{p.description || '—'}</td>
                <td className={`${TD} text-kumo-subtle`}>{formatDate(p.updatedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {canReadIssues ? (
        <section className="space-y-3">
          <SectionHeader title="Issues" />
          <p className="text-[12px] text-kumo-subtle">Read-only. Issues are changed from gadgets connected to this datastore.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SelectField
              label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` }))]}
            />
            <SelectField
              label="State"
              value={state}
              onChange={(e) => setState(e.target.value)}
              options={[{ value: '', label: 'Any state' }, ...workflow.states.map((s) => ({ value: s.key, label: s.name }))]}
            />
            <TextField label="Search issues" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Title or description" />
          </div>
          <ErrorNotice error={issueError} />
          {issues === null ? (
            <Loading label="Loading issues…" />
          ) : issues.length === 0 && !issueError ? (
            <Empty>No issues match.</Empty>
          ) : issues.length ? (
            <Table label="Issues" head={['Key', 'Title', 'State', 'Priority', 'Assignee', 'Updated']}>
              {issues.map((i) => (
                <tr key={i.id}>
                  <td className={`${TD} whitespace-nowrap`}>
                    <code>{i.key || `${projectKey.get(i.projectId) ?? '?'}-${i.number}`}</code>
                  </td>
                  <td className={TD}>{i.title}</td>
                  <td className={TD}>{stateName.get(i.state) ?? i.state}</td>
                  <td className={TD}>{i.priority === 'none' ? '—' : i.priority}</td>
                  <td className={TD}>{i.assignee?.displayName ?? '—'}</td>
                  <td className={`${TD} whitespace-nowrap text-kumo-subtle`}>{formatDate(i.updatedAt)}</td>
                </tr>
              ))}
            </Table>
          ) : null}
          {cursor ? (
            <div className="flex justify-center">
              <Btn onClick={() => void more()} loading={loadingMore}>
                Load more issues
              </Btn>
            </div>
          ) : null}
        </section>
      ) : null}

      <CreateProjectDialog
        open={creating}
        datastoreId={ds.id}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false)
          void loadProjects()
        }}
      />
    </div>
  )
}

function CreateProjectDialog({
  open,
  datastoreId,
  onClose,
  onCreated,
}: {
  open: boolean
  datastoreId: string
  onClose: () => void
  onCreated: () => void
}) {
  const api = useDataApi()
  const action = useAction()
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const close = () => {
    setKey('')
    setName('')
    setDescription('')
    action.setError(null)
    onClose()
  }
  const submit = async () => {
    const input = { key, name, description }
    const checked = validate(CreateProjectInputSchema, input)
    if (!checked.ok) {
      action.setError(checked.error)
      return
    }
    const project = await action.run(() => api.createProject(datastoreId, input))
    if (project) {
      setKey('')
      setName('')
      setDescription('')
      onCreated()
    }
  }
  return (
    <Modal open={open} onClose={close} busy={action.busy} title="New project">
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <TextField
          label="Key"
          value={key}
          onChange={(e) => setKey(e.target.value.toUpperCase())}
          placeholder="ENG"
          maxLength={10}
          hint="2–10 capitals and digits, starting with a letter. Issue keys use it, e.g. ENG-12."
          autoFocus
        />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        <TextAreaField label="Description" optional value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        <ErrorNotice error={action.error} />
        <ModalFooter>
          <Btn onClick={close} disabled={action.busy}>
            Cancel
          </Btn>
          <Btn tone="primary" type="submit" loading={action.busy}>
            Create project
          </Btn>
        </ModalFooter>
      </form>
    </Modal>
  )
}
