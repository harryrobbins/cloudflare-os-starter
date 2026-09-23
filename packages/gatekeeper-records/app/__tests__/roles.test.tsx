import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { FakeWorld } from './fake-api'
import { renderApp } from './render'

function world() {
  const w = new FakeWorld()
  const olga = w.person('Olga Owner')
  const adam = w.person('Adam Admin')
  const ada = w.person('Ada Admin Two')
  const eve = w.person('Eve Editor')
  const rita = w.person('Rita Reader')
  const ds = w.datastore('Engineering', { [olga.id]: 'owner', [adam.id]: 'admin', [ada.id]: 'admin', [eve.id]: 'editor', [rita.id]: 'reader' })
  return { w, olga, adam, ada, eve, rita, ds }
}

async function open(name: string) {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: new RegExp(name) }))
  await screen.findByRole('heading', { level: 2, name })
  return user
}

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent)

describe('role-based hiding', () => {
  test('a reader sees only Overview and Records, with no management actions', async () => {
    const { w, rita } = world()
    renderApp(w.as(rita.id))
    await open('Engineering')
    expect(tabNames()).toEqual(['Overview', 'Records'])
    expect(screen.queryByRole('button', { name: /archive/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /new datastore/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /directory/i })).toBeNull()
  })

  test('an editor also has no management tabs', async () => {
    const { w, eve } = world()
    renderApp(w.as(eve.id))
    await open('Engineering')
    expect(tabNames()).toEqual(['Overview', 'Records'])
  })

  test('an admin manages members but cannot grant admin, touch other admins, archive or transfer', async () => {
    const { w, adam } = world()
    renderApp(w.as(adam.id))
    const user = await open('Engineering')
    expect(tabNames()).toEqual(['Overview', 'Members', 'Connections', 'Credentials', 'Audit', 'Records'])
    expect(screen.getByRole('button', { name: /export json/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^archive$/i })).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Members' }))
    const table = await screen.findByRole('table', { name: 'Members' })
    expect(screen.queryByRole('button', { name: /transfer ownership/i })).toBeNull()
    // Editors and readers are manageable, with only editor/reader on offer.
    const eveRole = within(table).getByLabelText('Role for Eve Editor') as HTMLSelectElement
    expect([...eveRole.options].map((o) => o.value)).toEqual(['editor', 'reader'])
    expect(within(table).getByRole('button', { name: 'Remove Rita Reader' })).toBeTruthy()
    // The owner and the other admin are read-only for an admin.
    expect(within(table).queryByLabelText('Role for Olga Owner')).toBeNull()
    expect(within(table).queryByLabelText('Role for Ada Admin Two')).toBeNull()
    expect(within(table).queryByRole('button', { name: 'Remove Ada Admin Two' })).toBeNull()
  })

  test('an owner can archive, transfer ownership and grant admin', async () => {
    const { w, olga } = world()
    renderApp(w.as(olga.id))
    const user = await open('Engineering')
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeTruthy()
    await user.click(screen.getByRole('tab', { name: 'Members' }))
    const table = await screen.findByRole('table', { name: 'Members' })
    expect(screen.getByRole('button', { name: /transfer ownership/i })).toBeTruthy()
    const adaRole = within(table).getByLabelText('Role for Ada Admin Two') as HTMLSelectElement
    expect([...adaRole.options].map((o) => o.value)).toEqual(['admin', 'editor', 'reader'])
    // Nobody edits their own row.
    expect(within(table).queryByLabelText('Role for Olga Owner')).toBeNull()
  })

  test('changing a role calls setMemberRole and refreshes', async () => {
    const { w, olga, eve, ds } = world()
    renderApp(w.as(olga.id))
    const user = await open('Engineering')
    await user.click(screen.getByRole('tab', { name: 'Members' }))
    const table = await screen.findByRole('table', { name: 'Members' })
    await user.selectOptions(within(table).getByLabelText('Role for Eve Editor'), 'admin')
    expect(w.calls.find((c) => c.method === 'setMemberRole')?.args).toEqual([ds.id, { principalId: eve.id, role: 'admin' }])
    expect(ds.members.get(eve.id)?.role).toBe('admin')
  })

  test('tabs are keyboard operable', async () => {
    const { w, olga } = world()
    renderApp(w.as(olga.id))
    const user = await open('Engineering')
    screen.getByRole('tab', { name: 'Overview' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Members' }).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Members' }))
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Records' }).getAttribute('aria-selected')).toBe('true')
  })
})
