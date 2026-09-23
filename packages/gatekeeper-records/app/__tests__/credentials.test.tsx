import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { FakeWorld } from './fake-api'
import { renderApp } from './render'

afterEach(() => vi.restoreAllMocks())

async function openCredentials(role: 'owner' | 'admin' = 'admin', lifecycle: 'active' | 'archived' = 'active') {
  const w = new FakeWorld()
  const me = w.person('Adam Admin')
  const owner = w.person('Olga Owner')
  const ds = w.datastore('Engineering', role === 'owner' ? { [me.id]: 'owner' } : { [owner.id]: 'owner', [me.id]: 'admin' }, { lifecycle })
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  if (lifecycle === 'archived') await user.click(await screen.findByLabelText('Include archived'))
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  await user.click(await screen.findByRole('tab', { name: 'Credentials' }))
  await screen.findByRole('heading', { name: 'Credentials' })
  return { w, ds, user }
}

test('the credential secret is shown once, then gone', async () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
  const log = vi.spyOn(console, 'log')
  const { w, ds, user } = await openCredentials()

  await user.click(screen.getByRole('button', { name: /new credential/i }))
  const dialog = await screen.findByRole('dialog')
  // Scopes offered are exactly what an admin holds among service scopes.
  const boxes = within(dialog).getAllByRole('checkbox')
  expect(boxes).toHaveLength(7)
  await user.type(within(dialog).getByLabelText('Name'), 'Nightly export')
  await user.click(within(dialog).getByLabelText(/Read the audit log/))
  const days = within(dialog).getByLabelText('Expires after (days)')
  await user.clear(days)
  await user.type(days, '30')
  await user.click(within(dialog).getByRole('button', { name: 'Create credential' }))

  const created = w.calls.find((c) => c.method === 'createCredential')!
  expect(created.args).toEqual([ds.id, { label: 'Nightly export', scopes: ['projects.read', 'issues.read', 'audit.read'], expiresInDays: 30 }])

  const secretBox = (await screen.findByLabelText('Nightly export')) as HTMLInputElement
  const secret = secretBox.value
  expect(secret).toMatch(/^rk1_[0-9a-f]{32}_/)
  expect(screen.getByText(/will not be shown again/i)).toBeTruthy()
  const example = screen.getByLabelText('Example request').textContent!
  expect(example).toContain(`https://data.example.test/gatekeeper/records/v1/datastores/${ds.id}/projects`)
  expect(example).not.toContain(secret)

  await user.click(screen.getByRole('button', { name: /I've stored it/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.body.innerHTML).not.toContain(secret)
  // The list shows the prefix only.
  const table = await screen.findByRole('table', { name: 'Credentials' })
  expect(within(table).getByText('Nightly export')).toBeTruthy()
  expect(table.textContent).not.toContain(secret)

  // Reopening starts a fresh form; the old secret is not recoverable.
  await user.click(screen.getByRole('button', { name: /new credential/i }))
  await screen.findByRole('dialog')
  expect(document.body.innerHTML).not.toContain(secret)

  for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(secret)
  for (const call of log.mock.calls) expect(call.join(' ')).not.toContain(secret)
  expect(window.location.href).not.toContain(secret)
})

test('an owner can offer every service scope; an invalid expiry is caught before the call', async () => {
  const { w, user } = await openCredentials('owner')
  await user.click(screen.getByRole('button', { name: /new credential/i }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Too long')
  const days = within(dialog).getByLabelText('Expires after (days)')
  await user.clear(days)
  await user.type(days, '999')
  await user.click(within(dialog).getByRole('button', { name: 'Create credential' }))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('Some details need correcting')
  expect(alert.textContent).toContain('expiresInDays')
  expect(w.calls.some((c) => c.method === 'createCredential')).toBe(false)
})

test('revoking a credential asks first, then calls revokeCredential', async () => {
  const { w, ds, user } = await openCredentials()
  await w.as([...ds.members.keys()][1]!).createCredential(ds.id, { label: 'CI', scopes: ['issues.read'], expiresInDays: 10 })
  await user.click(screen.getByRole('tab', { name: 'Audit' }))
  await user.click(screen.getByRole('tab', { name: 'Credentials' }))
  await user.click(await screen.findByRole('button', { name: 'Revoke CI' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))
  await waitFor(() => expect(w.calls.some((c) => c.method === 'revokeCredential')).toBe(true))
  const table = await screen.findByRole('table', { name: 'Credentials' })
  await waitFor(() => expect(within(table).getByText('Revoked')).toBeTruthy())
})

test('archived datastores cannot mint credentials', async () => {
  await openCredentials('admin', 'archived')
  expect((screen.getByRole('button', { name: /new credential/i }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getAllByText(/archived/i).length).toBeGreaterThan(0)
})
