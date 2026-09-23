import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { FakeWorld, issue, uuid } from './fake-api'
import { renderApp } from './render'

const listItems = () => within(screen.getByRole('navigation', { name: 'Datastores' })).getAllByRole('listitem')

test('the datastore list pages with a cursor', async () => {
  const w = new FakeWorld()
  const me = w.person('Rita')
  for (let i = 1; i <= 7; i++) w.datastore(`Store ${String(i).padStart(2, '0')}`, { [me.id]: 'reader' })
  renderApp(w.as(me.id), { pageSize: 3 })
  const user = userEvent.setup()
  await screen.findByRole('button', { name: /Store 01/ })
  expect(listItems()).toHaveLength(3)
  await user.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(listItems()).toHaveLength(6))
  const second = w.calls.filter((c) => c.method === 'searchDatastores').at(-1)!
  expect(second.args[0]).toMatchObject({ cursor: '3', limit: 3 })
  await user.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(listItems()).toHaveLength(7))
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
})

test('search and include-archived restart from the first page', async () => {
  const w = new FakeWorld()
  const me = w.person('Rita')
  w.datastore('Alpha', { [me.id]: 'reader' })
  w.datastore('Beta', { [me.id]: 'reader' })
  w.datastore('Old Alpha', { [me.id]: 'reader' }, { lifecycle: 'archived' })
  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await screen.findByRole('button', { name: /Beta/ })
  expect(listItems()).toHaveLength(2)
  await user.type(screen.getByLabelText('Search datastores'), 'alpha')
  await waitFor(() => expect(listItems()).toHaveLength(1))
  await user.click(screen.getByLabelText('Include archived'))
  await waitFor(() => expect(listItems()).toHaveLength(2))
  expect(within(screen.getByRole('navigation', { name: 'Datastores' })).getByText('Archived')).toBeTruthy()
  const last = w.calls.filter((c) => c.method === 'searchDatastores').at(-1)!
  expect(last.args[0]).toMatchObject({ query: 'alpha', includeArchived: true })
  expect(last.args[0]).not.toHaveProperty('cursor')
})

test('audit and issues page too', async () => {
  const w = new FakeWorld()
  const me = w.person('Olga')
  const ds = w.datastore('Engineering', { [me.id]: 'owner' })
  for (let i = 0; i < 60; i++) {
    ds.audit.push({
      id: uuid(), datastoreId: ds.id, operation: 'addMember', actor: w.ref(me.id), initiator: null, bindingId: null,
      via: 'management', targetType: null, targetId: null, summary: `Event ${i}`, at: '2026-09-23T10:00:00.000Z',
    })
  }
  const project = { id: uuid(), key: 'ENG', name: 'Engineering', description: '', revision: 1, createdAt: '', updatedAt: '' }
  ds.projects.push(project)
  for (let i = 1; i <= 55; i++) ds.issues.push(issue(project, i, `Issue ${i}`, i % 2 ? 'todo' : 'done'))

  renderApp(w.as(me.id))
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Engineering/ }))
  await user.click(await screen.findByRole('tab', { name: 'Audit' }))
  const audit = await screen.findByRole('table', { name: 'Audit log' })
  expect(within(audit).getAllByRole('row')).toHaveLength(51)
  await user.click(screen.getByRole('button', { name: 'Load older events' }))
  await waitFor(() => expect(within(screen.getByRole('table', { name: 'Audit log' })).getAllByRole('row')).toHaveLength(61))

  await user.click(screen.getByRole('tab', { name: 'Records' }))
  const issues = await screen.findByRole('table', { name: 'Issues' })
  expect(within(issues).getAllByRole('row')).toHaveLength(51)
  await user.selectOptions(screen.getByLabelText('State'), 'done')
  await waitFor(() => expect(within(screen.getByRole('table', { name: 'Issues' })).getAllByRole('row')).toHaveLength(28))
  expect(screen.queryByRole('button', { name: 'Load more issues' })).toBeNull()
  expect(w.calls.filter((c) => c.method === 'listIssues').at(-1)!.args[1]).toMatchObject({ state: 'done' })
})
