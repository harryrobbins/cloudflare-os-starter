import { RecordsError } from '@records/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { describeError } from '../errors'
import { FakeWorld } from './fake-api'
import { renderApp } from './render'

describe('describeError', () => {
  test.each([
    ['forbidden: This needs members.manage.', 'forbidden', "You don't have permission to do that", 'This needs members.manage.'],
    ['not_found: Unknown datastore.', 'not_found', 'Not found', 'Unknown datastore.'],
    ['datastore_archived: The datastore is archived.', 'datastore_archived', 'This datastore is archived and read-only', 'The datastore is archived.'],
    ['duplicate: That person is already a member.', 'duplicate', 'That already exists', 'That person is already a member.'],
    ['unavailable: Database unreachable.', 'unavailable', 'The data service is unavailable. Try again shortly', 'Database unreachable.'],
  ])('maps %s', (message, code, title, detail) => {
    const d = describeError(new Error(message))
    expect(d).toMatchObject({ code, title, detail, issues: [] })
  })

  test('keeps validation issues when the error carries them', () => {
    const d = describeError(new RecordsError('validation_failed', 'The request did not match the contract.', [{ path: 'name', message: 'Too small' }]))
    expect(d.code).toBe('validation_failed')
    expect(d.issues).toEqual([{ path: 'name', message: 'Too small' }])
  })

  test('unknown errors get a generic title', () => {
    expect(describeError(new Error('boom'))).toMatchObject({ code: null, title: 'Something went wrong', detail: 'boom' })
  })
})

test('a failed listing renders an alert with the mapped message', async () => {
  const w = new FakeWorld()
  const me = w.person('Rita')
  w.failures.set('searchDatastores', new Error('unavailable: The database is restarting.'))
  renderApp(w.as(me.id))
  const alert = await screen.findByRole('alert')
  expect(alert.getAttribute('data-error-code')).toBe('unavailable')
  expect(alert.textContent).toContain('The data service is unavailable')
  expect(alert.textContent).toContain('The database is restarting.')
})

test('a duplicate member error shows in the add dialog', async () => {
  const w = new FakeWorld()
  const me = w.person('Olga')
  const bob = w.person('Bob')
  w.datastore('Engineering', { [me.id]: 'owner' })
  w.failures.set('addMember', new Error('duplicate: That person is already a member.'))
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  await user.click(await screen.findByRole('tab', { name: 'Members' }))
  await user.click(await screen.findByRole('button', { name: 'Add member' }))
  const dialog = await screen.findByRole('dialog')
  await user.click(await within(dialog).findByRole('button', { name: /Bob/ }))
  await user.click(within(dialog).getByRole('button', { name: 'Add' }))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('That already exists')
  expect(bob.id).toBeTruthy()
})

test('server-side validation issues are listed', async () => {
  const w = new FakeWorld()
  const me = w.person('Olga')
  w.datastore('Engineering', { [me.id]: 'owner' })
  w.failures.set(
    'createProject',
    new RecordsError('validation_failed', 'The request did not match the contract.', [{ path: 'key', message: 'a project key is 2-10 capitals and digits' }]),
  )
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  await user.click(await screen.findByRole('tab', { name: 'Records' }))
  await user.click(await screen.findByRole('button', { name: 'New project' }))
  const dialog = await screen.findByRole('dialog')
  await user.type(within(dialog).getByLabelText('Key'), 'ENG')
  await user.type(within(dialog).getByLabelText('Name'), 'Engineering')
  await user.click(within(dialog).getByRole('button', { name: 'Create project' }))
  const alert = await within(dialog).findByRole('alert')
  expect(alert.textContent).toContain('Some details need correcting')
  expect(alert.textContent).toContain('a project key is 2-10 capitals and digits')
})

test('forbidden on a datastore detail is shown in place', async () => {
  const w = new FakeWorld()
  const me = w.person('Rita')
  w.datastore('Engineering', { [me.id]: 'reader' })
  w.failures.set('getDatastore', new Error('forbidden: Your membership was revoked.'))
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain("You don't have permission")
  expect(alert.textContent).toContain('Your membership was revoked.')
})
