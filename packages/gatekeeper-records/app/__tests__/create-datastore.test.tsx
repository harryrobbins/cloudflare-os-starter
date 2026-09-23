import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { FakeWorld } from './fake-api'
import { renderApp } from './render'

function setup() {
  const w = new FakeWorld()
  const dana = w.person('Dana Admin', { dataAdmin: true })
  const olga = w.person('Olga Owner')
  renderApp(w.as(dana.id))
  return { w, dana, olga, user: userEvent.setup() }
}

test('non-administrators cannot create datastores', async () => {
  const w = new FakeWorld()
  const rita = w.person('Rita')
  renderApp(w.as(rita.id))
  await screen.findByText('Rita')
  expect(screen.queryByRole('button', { name: /new datastore/i })).toBeNull()
})

test('a data administrator creates a datastore for someone else', async () => {
  const { w, olga, user } = setup()
  await user.click(await screen.findByRole('button', { name: /new datastore/i }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Finance')
  await user.type(within(dialog).getByLabelText('Owner'), 'olga')
  await user.click(await within(dialog).findByRole('button', { name: /Olga Owner/ }))
  await user.click(within(dialog).getByLabelText(/Whole organisation/))
  await user.type(within(dialog).getByLabelText('Key'), 'fin')
  await user.type(within(dialog).getByLabelText('Project name'), 'Budget')
  await user.click(within(dialog).getByRole('button', { name: 'Create datastore' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  const call = w.calls.find((c) => c.method === 'createDatastore')!
  expect(call.args[0]).toMatchObject({
    name: 'Finance',
    moduleId: 'projects',
    ownerPrincipalId: olga.id,
    discovery: 'organisation',
    initialProject: { key: 'FIN', name: 'Budget' },
  })
  // The creator is not a member, and is told why the new datastore is not listed.
  expect((await screen.findByRole('status')).textContent).toContain('You are not a member')
  expect(screen.queryByRole('button', { name: /Finance/ })).toBeNull()
})

test('choosing yourself as owner opens the new datastore', async () => {
  const { user } = setup()
  await user.click(await screen.findByRole('button', { name: /new datastore/i }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Name'), 'Mine')
  await user.click(within(dialog).getByRole('button', { name: 'Make me the owner' }))
  await user.click(within(dialog).getByRole('button', { name: 'Create datastore' }))
  expect(await screen.findByRole('heading', { level: 2, name: 'Mine' })).toBeTruthy()
  expect(await screen.findByRole('button', { name: /Mine/ })).toBeTruthy()
})

test('missing fields are reported before calling the service', async () => {
  const { w, user } = setup()
  await user.click(await screen.findByRole('button', { name: /new datastore/i }))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByRole('button', { name: 'Create datastore' }))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('Choose an owner')
  expect(alert.textContent).toContain('name')
  expect(w.calls.some((c) => c.method === 'createDatastore')).toBe(false)
})

test('the directory invites people and toggles data administrators', async () => {
  const { w, olga, user } = setup()
  await user.click(await screen.findByRole('button', { name: /directory/i }))
  await user.type(screen.getByLabelText('E-mail'), 'new.person@example.test')
  await user.type(screen.getByLabelText('Name'), 'New Person')
  await user.click(screen.getByRole('button', { name: 'Add person' }))
  expect((await screen.findByText(/Added New Person/)).textContent).toContain('directory')

  await user.type(screen.getByLabelText('Person'), 'olga')
  await user.click(await screen.findByRole('button', { name: /Olga Owner/ }))
  await user.click(screen.getByRole('button', { name: 'Make data administrator' }))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Grant' }))
  await waitFor(() => expect(w.people.get(olga.id)!.dataAdmin).toBe(true))
})
