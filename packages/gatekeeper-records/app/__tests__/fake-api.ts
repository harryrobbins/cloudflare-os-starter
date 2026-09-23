// An in-memory DataManagementApi for component tests. It follows the registry's rules closely
// enough to exercise the page (role matrix, canAssignRole, archived read-only, one-time secrets)
// and throws errors shaped like ones that crossed RPC: `Error("<code>: <detail>")`.

import {
  AddMemberInputSchema,
  canAssignRole,
  CreateCredentialInputSchema,
  CreateDatastoreInputSchema,
  CreateProjectInputSchema,
  DEFAULT_WORKFLOW,
  parseInput,
  RecordsError,
  RemoveMemberInputSchema,
  ROLE_PERMISSIONS,
  SetMemberRoleInputSchema,
  TransferOwnershipInputSchema,
  type AuditEvent,
  type Binding,
  type CredentialInfo,
  type DatastoreDetail,
  type DatastoreRole,
  type DatastoreSummary,
  type DiscoveryPolicy,
  type ErrorCode,
  type Issue,
  type Member,
  type Page,
  type Permission,
  type PrincipalRef,
  type Project,
} from '@records/contracts'
import type { DataApi, DirectoryPerson, Whoami } from '../api'

type Person = DirectoryPerson & { dataAdmin: boolean; status: 'active' | 'disabled' }

type Store = {
  id: string
  name: string
  description: string
  lifecycle: 'active' | 'archived'
  discovery: DiscoveryPolicy
  ownerTeam: string | null
  ownerId: string
  members: Map<string, { role: DatastoreRole; grantedAt: string }>
  bindings: Binding[]
  credentials: CredentialInfo[]
  audit: AuditEvent[]
  projects: Project[]
  issues: Issue[]
  createdAt: string
}

let counter = 0
export function uuid(): string {
  counter += 1
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`
}

const NOW = '2026-09-23T10:00:00.000Z'

function fail(code: ErrorCode, detail: string): never {
  // What arrives over RPC: only name and message survive.
  throw new Error(`${code}: ${detail}`)
}

export class FakeWorld {
  people = new Map<string, Person>()
  stores = new Map<string, Store>()
  calls: { method: string; args: unknown[] }[] = []
  /** Force the next call to `method` to throw this error. */
  failures = new Map<string, Error>()

  person(displayName: string, opts: { dataAdmin?: boolean; email?: string } = {}): Person {
    const p: Person = {
      id: uuid(),
      displayName,
      kind: 'human',
      email: opts.email ?? `${displayName.toLowerCase().replace(/\s+/g, '.')}@example.test`,
      dataAdmin: opts.dataAdmin ?? false,
      status: 'active',
    }
    this.people.set(p.id, p)
    return p
  }

  datastore(name: string, members: Record<string, DatastoreRole>, opts: Partial<Pick<Store, 'lifecycle' | 'description'>> = {}): Store {
    const ownerId = Object.entries(members).find(([, r]) => r === 'owner')?.[0] ?? Object.keys(members)[0]!
    const s: Store = {
      id: uuid(),
      name,
      description: opts.description ?? `${name} records`,
      lifecycle: opts.lifecycle ?? 'active',
      discovery: 'members',
      ownerTeam: null,
      ownerId,
      members: new Map(Object.entries(members).map(([id, role]) => [id, { role, grantedAt: NOW }])),
      bindings: [],
      credentials: [],
      audit: [],
      projects: [],
      issues: [],
      createdAt: NOW,
    }
    this.stores.set(s.id, s)
    return s
  }

  ref(id: string): PrincipalRef {
    const p = this.people.get(id)
    if (p) return { id: p.id, displayName: p.displayName, kind: p.kind }
    return { id, displayName: 'Service', kind: 'service' }
  }

  /** The capability as seen by one signed-in person. */
  as(principalId: string): DataApi {
    const world = this
    const me = () => world.people.get(principalId)!
    const record = (method: string, args: unknown[]) => {
      world.calls.push({ method, args })
      const f = world.failures.get(method)
      if (f) {
        world.failures.delete(method)
        throw f
      }
    }
    const store = (id: string) => {
      const s = world.stores.get(id)
      if (!s || !s.members.has(principalId)) fail('not_found', 'Unknown datastore.')
      return s
    }
    const roleIn = (s: Store) => s.members.get(principalId)?.role ?? null
    const need = (id: string, perm: Permission) => {
      const s = store(id)
      const role = roleIn(s)!
      if (!ROLE_PERMISSIONS[role].has(perm)) fail('forbidden', `This needs ${perm}.`)
      return { s, role }
    }
    const writable = (s: Store) => {
      if (s.lifecycle === 'archived') fail('datastore_archived', 'The datastore is archived.')
    }
    const summary = (s: Store): DatastoreSummary => ({
      id: s.id,
      name: s.name,
      description: s.description,
      moduleId: 'projects',
      apiMajor: 1,
      features: ['issues'],
      lifecycle: s.lifecycle,
      ownerTeam: s.ownerTeam,
      discovery: s.discovery,
      role: roleIn(s),
      createdAt: s.createdAt,
      updatedAt: s.createdAt,
    })
    const audit = (s: Store, operation: string, text: string) => {
      s.audit.unshift({
        id: uuid(),
        datastoreId: s.id,
        operation,
        actor: world.ref(principalId),
        initiator: null,
        bindingId: null,
        via: 'management',
        targetType: null,
        targetId: null,
        summary: text,
        at: NOW,
      })
    }
    const page = <T>(items: T[], input: unknown, def = 50): Page<T> => {
      const { limit = def, cursor } = (input ?? {}) as { limit?: number; cursor?: string }
      const start = cursor ? Number(cursor) : 0
      const slice = items.slice(start, start + limit)
      return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null }
    }
    const membership = (id: string, target: string, role: DatastoreRole | null, op: 'add' | 'set' | 'remove') => {
      const { s, role: mine } = need(id, 'members.manage')
      const current = s.members.get(target)?.role ?? null
      if (current === 'owner') fail('forbidden', "Transfer ownership before changing the owner's membership.")
      if (current && !canAssignRole(mine, current)) fail('forbidden', `An ${mine} cannot change a ${current}.`)
      if (role && !canAssignRole(mine, role)) fail('forbidden', `An ${mine} cannot grant ${role}.`)
      if (op === 'add' && current) fail('duplicate', 'That person is already a member.')
      if (op !== 'add' && !current) fail('not_found', 'That person is not a member.')
      if (op === 'remove') s.members.delete(target)
      else s.members.set(target, { role: role!, grantedAt: NOW })
      audit(s, op === 'remove' ? 'removeMember' : op === 'add' ? 'addMember' : 'setMemberRole', `Membership ${op}`)
    }

    const api: DataApi = {
      async whoami(): Promise<Whoami> {
        record('whoami', [])
        const p = me()
        return { orgId: 'org', principal: world.ref(p.id), email: p.email, dataAdmin: p.dataAdmin }
      },
      async listDataAdmins() {
        record('listDataAdmins', [])
        if (!me().dataAdmin) fail('forbidden', 'This needs the data administrator role.')
        return [...world.people.values()].filter((p) => p.dataAdmin).map((p) => world.ref(p.id))
      },
      async apiBase() {
        record('apiBase', [])
        return 'https://data.example.test/gatekeeper/records/v1'
      },
      async searchDatastores(input) {
        record('searchDatastores', [input])
        const { query = '', includeArchived = false } = (input ?? {}) as { query?: string; includeArchived?: boolean }
        const items = [...world.stores.values()]
          .filter((s) => s.members.has(principalId))
          .filter((s) => includeArchived || s.lifecycle === 'active')
          .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .map(summary)
        return page(items, input)
      },
      async getDatastore(id) {
        record('getDatastore', [id])
        const s = store(id)
        const role = roleIn(s)!
        if (!ROLE_PERMISSIONS[role].has('members.manage')) return summary(s)
        const detail: DatastoreDetail = {
          ...summary(s),
          owner: world.ref(s.ownerId),
          retentionPolicy: 'retain-until-deleted',
          environment: 'production',
          placement: 'primary',
          moduleVersion: '1.0.0',
          memberCount: s.members.size,
          activeBindingCount: s.bindings.filter((b) => b.status === 'active').length,
          activeCredentialCount: s.credentials.filter((c) => !c.revokedAt).length,
          revision: 1,
        }
        return detail
      },
      async createDatastore(raw) {
        record('createDatastore', [raw])
        if (!me().dataAdmin) fail('forbidden', 'This needs the data administrator role.')
        const input = parseInput(CreateDatastoreInputSchema, raw)
        const s = world.datastore(input.name, { [input.ownerPrincipalId]: 'owner' }, { description: input.description })
        s.discovery = input.discovery
        s.ownerTeam = input.ownerTeam
        if (input.initialProject) {
          s.projects.push({ id: uuid(), key: input.initialProject.key, name: input.initialProject.name, description: '', revision: 1, createdAt: NOW, updatedAt: NOW })
        }
        return summary(s)
      },
      async setLifecycle(id, lifecycle) {
        record('setLifecycle', [id, lifecycle])
        const { s } = need(id, 'lifecycle.manage')
        s.lifecycle = lifecycle
      },
      async exportDatastore(id) {
        record('exportDatastore', [id])
        const { s } = need(id, 'export.run')
        return { datastore: summary(s), projects: s.projects, issues: s.issues }
      },
      async listMembers(id) {
        record('listMembers', [id])
        const { s } = need(id, 'members.manage')
        return [...s.members.entries()].map(([pid, m]): Member => ({ principal: world.ref(pid), role: m.role, grantedAt: m.grantedAt }))
      },
      async addMember(id, raw) {
        record('addMember', [id, raw])
        const input = parseInput(AddMemberInputSchema, raw)
        membership(id, input.principalId, input.role, 'add')
      },
      async setMemberRole(id, raw) {
        record('setMemberRole', [id, raw])
        const input = parseInput(SetMemberRoleInputSchema, raw)
        membership(id, input.principalId, input.role, 'set')
      },
      async removeMember(id, raw) {
        record('removeMember', [id, raw])
        const input = parseInput(RemoveMemberInputSchema, raw)
        membership(id, input.principalId, null, 'remove')
      },
      async transferOwnership(id, raw) {
        record('transferOwnership', [id, raw])
        const input = parseInput(TransferOwnershipInputSchema, raw)
        const { s } = need(id, 'ownership.transfer')
        s.members.set(s.ownerId, { role: 'admin', grantedAt: NOW })
        s.members.set(input.newOwnerPrincipalId, { role: 'owner', grantedAt: NOW })
        s.ownerId = input.newOwnerPrincipalId
      },
      async searchPrincipals(raw) {
        record('searchPrincipals', [raw])
        const q = (((raw ?? {}) as { query?: string }).query ?? '').toLowerCase()
        return [...world.people.values()]
          .filter((p) => p.status === 'active' && (p.displayName.toLowerCase().includes(q) || (p.email ?? '').includes(q)))
          .toSorted((a, b) => a.displayName.localeCompare(b.displayName))
          .slice(0, 20)
          .map((p) => ({ id: p.id, displayName: p.displayName, kind: p.kind, email: p.email }))
      },
      async invitePrincipal(raw) {
        record('invitePrincipal', [raw])
        if (!me().dataAdmin) fail('forbidden', 'This needs the data administrator role.')
        const { email, displayName } = raw as { email: string; displayName: string }
        if ([...world.people.values()].some((p) => p.email === email.toLowerCase())) fail('duplicate', 'That person is already in the directory.')
        const p = world.person(displayName, { email: email.toLowerCase() })
        return world.ref(p.id)
      },
      async setDataAdmin(raw) {
        record('setDataAdmin', [raw])
        if (!me().dataAdmin) fail('forbidden', 'This needs the data administrator role.')
        const { principalId: target, enabled } = raw as { principalId: string; enabled: boolean }
        world.people.get(target)!.dataAdmin = enabled
      },
      async listBindings(id) {
        record('listBindings', [id])
        return need(id, 'bindings.manage').s.bindings
      },
      async revokeBinding(bindingId) {
        record('revokeBinding', [bindingId])
        const s = [...world.stores.values()].find((x) => x.bindings.some((b) => b.id === bindingId))
        if (!s) fail('not_found', 'Unknown connection.')
        need(s.id, 'bindings.manage')
        const b = s.bindings.find((x) => x.id === bindingId)!
        b.status = 'revoked'
        b.revokedAt = NOW
      },
      async listCredentials(id) {
        record('listCredentials', [id])
        return need(id, 'credentials.manage').s.credentials
      },
      async createCredential(id, raw) {
        record('createCredential', [id, raw])
        const input = parseInput(CreateCredentialInputSchema, raw)
        const { s, role } = need(id, 'credentials.manage')
        writable(s)
        const beyond = input.scopes.filter((x) => !ROLE_PERMISSIONS[role].has(x))
        if (beyond.length) fail('forbidden', `You do not hold ${beyond.join(', ')} on this datastore.`)
        const credId = uuid()
        const hex = credId.replaceAll('-', '')
        const credential: CredentialInfo = {
          id: credId,
          bindingId: uuid(),
          label: input.label,
          prefix: `rk1_${hex.slice(0, 8)}`,
          scopes: input.scopes,
          servicePrincipal: { id: uuid(), displayName: input.label, kind: 'service' },
          owner: world.ref(principalId),
          createdAt: NOW,
          expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString(),
          revokedAt: null,
          lastUsedAt: null,
        }
        s.credentials.push(credential)
        return { credential, secret: `rk1_${hex}_SECRETsecretSECRET${counter}` }
      },
      async revokeCredential(id, credentialId) {
        record('revokeCredential', [id, credentialId])
        const { s } = need(id, 'credentials.manage')
        const c = s.credentials.find((x) => x.id === credentialId)
        if (!c) fail('not_found', 'Unknown credential.')
        c.revokedAt = NOW
      },
      async listAudit(id, input) {
        record('listAudit', [id, input])
        return page(need(id, 'audit.read').s.audit, input)
      },
      async listProjects(id) {
        record('listProjects', [id])
        return need(id, 'projects.read').s.projects
      },
      async createProject(id, raw) {
        record('createProject', [id, raw])
        const input = parseInput(CreateProjectInputSchema, raw)
        const { s } = need(id, 'projects.manage')
        writable(s)
        if (s.projects.some((p) => p.key === input.key)) fail('duplicate', 'A project with that key exists.')
        const p: Project = { id: uuid(), ...input, revision: 1, createdAt: NOW, updatedAt: NOW }
        s.projects.push(p)
        return p
      },
      async getWorkflow(id) {
        record('getWorkflow', [id])
        need(id, 'projects.read')
        return DEFAULT_WORKFLOW
      },
      async listIssues(id, input) {
        record('listIssues', [id, input])
        const { s } = need(id, 'issues.read')
        const f = (input ?? {}) as { projectId?: string; state?: string; query?: string }
        const items = s.issues
          .filter((i) => !f.projectId || i.projectId === f.projectId)
          .filter((i) => !f.state || i.state === f.state)
          .filter((i) => !f.query || i.title.toLowerCase().includes(f.query.toLowerCase()))
        return page(items, input)
      },
    }
    return api
  }
}

export function issue(project: Project, number: number, title: string, state = 'todo', by?: PrincipalRef): Issue {
  const who = by ?? { id: uuid(), displayName: 'Someone', kind: 'human' as const }
  return {
    id: uuid(),
    projectId: project.id,
    number,
    key: `${project.key}-${number}`,
    title,
    description: '',
    state,
    priority: 'none',
    assignee: null,
    customFields: {},
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: who,
    updatedBy: who,
  }
}

export { RecordsError }
