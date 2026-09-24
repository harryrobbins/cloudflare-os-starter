import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from 'vitest'
import { FakeWorld } from './fake-api'
import { renderApp } from './render'

afterEach(() => vi.restoreAllMocks())

async function openWebhooks() {
  const w = new FakeWorld()
  const me = w.person('Adam Admin')
  const owner = w.person('Olga Owner')
  const ds = w.datastore('Engineering', { [owner.id]: 'owner', [me.id]: 'admin' })
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  await user.click(await screen.findByRole('tab', { name: 'Webhooks' }))
  await screen.findByRole('heading', { name: 'Webhooks' })
  return { w, ds, user }
}

test('the signing secret is shown once, then gone', async () => {
  const setItem = vi.spyOn(Storage.prototype, 'setItem')
  const log = vi.spyOn(console, 'log')
  const { w, ds, user } = await openWebhooks()

  await user.click(screen.getByRole('button', { name: /new webhook/i }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Deploy bot')
  const url = within(dialog).getByLabelText('Destination URL')
  await user.clear(url)
  await user.type(url, 'https://hooks.example.com/in')
  await user.selectOptions(within(dialog).getByLabelText('Payload format'), 'jira')
  // Jira format offers only the events Jira has.
  expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3)
  await user.click(within(dialog).getByLabelText(/Comment added/))
  await user.click(within(dialog).getByRole('button', { name: 'Create webhook' }))

  const created = w.calls.find((c) => c.method === 'createWebhook')!
  expect(created.args).toEqual([ds.id, { label: 'Deploy bot', url: 'https://hooks.example.com/in', format: 'jira', events: ['issue.created', 'issue.updated'] }])
  const secret = ((await screen.findByLabelText('Deploy bot')) as HTMLInputElement).value
  expect(secret).toMatch(/^whsec_/)
  expect(screen.getByText(/will not be shown again/i)).toBeTruthy()
  expect(screen.getByText(/X-Hub-Signature/)).toBeTruthy()

  await user.click(screen.getByRole('button', { name: /I've stored it/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const table = await screen.findByRole('table', { name: 'Webhooks' })
  expect(within(table).getByText('Deploy bot')).toBeTruthy()
  expect(document.body.innerHTML).not.toContain(secret)
  for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(secret)
  for (const call of log.mock.calls) expect(call.join(' ')).not.toContain(secret)
})

test('a refused destination shows the server error and keeps the dialog open', async () => {
  const { w, user } = await openWebhooks()
  await user.click(screen.getByRole('button', { name: /new webhook/i }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Local')
  const url = within(dialog).getByLabelText('Destination URL')
  await user.clear(url)
  await user.type(url, 'https://localhost/x')
  await user.click(within(dialog).getByRole('button', { name: 'Create webhook' }))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toMatch(/public host/)
  expect(w.calls.filter((c) => c.method === 'createWebhook')).toHaveLength(1)
})

test('test, disable and delete', async () => {
  const { w, ds, user } = await openWebhooks()
  const adam = [...ds.members.keys()][1]!
  await w.as(adam).createWebhook(ds.id, { label: 'CI', url: 'https://ci.example.com/hook' })
  await user.click(screen.getByRole('tab', { name: 'Audit' }))
  await user.click(screen.getByRole('tab', { name: 'Webhooks' }))

  await user.click(await screen.findByRole('button', { name: 'Test CI' }))
  const deliveries = await screen.findByRole('table', { name: 'Deliveries' })
  expect(within(deliveries).getByText('Test')).toBeTruthy()
  expect(within(deliveries).getByText('Waiting')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Done' }))

  await user.click(await screen.findByRole('button', { name: 'Disable CI' }))
  await waitFor(() => expect(w.calls.some((c) => c.method === 'setWebhookEnabled' && c.args[2] === false)).toBe(true))
  expect(await screen.findByRole('button', { name: 'Enable CI' })).toBeTruthy()

  await user.click(screen.getByRole('button', { name: 'Delete CI' }))
  const confirm = await screen.findByRole('dialog')
  await user.click(within(confirm).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(w.calls.some((c) => c.method === 'deleteWebhook')).toBe(true))
  expect(await screen.findByText('No webhooks yet.')).toBeTruthy()
})
