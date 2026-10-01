// Records Explorer UI: a read-only browser over one Records datastore (see ../README.md).
// Every value shown comes from the service or its public model and is treated as untrusted text:
// nothing here parses HTML, fetches IRIs or executes record content.
import { LIMITS, TABS, actorLabel, isUuid } from '../shared/validation.js'

const ACTIVITY_MS = 5_000
const TAB_LABELS = { records: 'Records', model: 'Model', activity: 'Activity', connection: 'Connection' }
const display = value => value === undefined ? '' : value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const code = error => /^([a-z_]+): /.exec(error?.message || '')?.[1] ?? null
const detail = error => { const message = error?.message || String(error); return code(error) ? message.slice(message.indexOf(':') + 1).trim() : message }
const shortId = id => typeof id === 'string' ? `${id.slice(0, 8)}…` : display(id)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {{ gadget: any, root: HTMLElement, doc?: Document, timers?: boolean }} options
 */
export function createExplorer({ gadget, root, doc = document, timers = true }) {
  const s = {
    phase: 'loading', failure: null, connection: null, description: null, model: null, entities: [], prefs: {},
    tab: 'records', entity: null, page: null, history: [], after: undefined, ended: false, busy: false, notice: '',
    filter: '', lookup: '', inspected: null, showSchema: {},
    activity: { cursor: null, epoch: undefined, items: [], note: '', started: false },
  }
  let timer = null
  let disposed = false

  const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node }
  const button = (label, action, className = 'quiet', attrs = {}) => {
    const node = el('button', className, label); node.type = 'button'
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    node.addEventListener('click', () => run(action)); return node
  }
  const run = async action => {
    try { await action() } catch (error) {
      const c = code(error)
      if (c === 'forbidden' || c === 'not_connected') { s.phase = 'failure'; s.failure = { code: c, message: detail(error) } }
      else s.notice = detail(error)
      render()
    }
  }

  // ---------------------------------------------------------------- data

  const module = () => s.description?.modules?.find(item => item.id === s.description.module_id) ?? s.description?.modules?.[0] ?? null
  const profile = () => s.model?.profile ?? module()?.profile ?? null
  const entityProfile = entity => profile()?.entities?.[entity] ?? null
  const profileFields = entity => Object.keys(entityProfile(entity)?.fields ?? {})
  const columns = entity => {
    const known = profileFields(entity)
    const chosen = s.prefs.columns?.[entity]?.filter(field => known.includes(field))
    return chosen?.length ? chosen : known.filter(field => field !== 'extensions').slice(0, 6)
  }

  async function savePrefs() {
    try { s.prefs = await gadget.setState({ ...s.prefs, entity: s.entity ?? undefined, tab: s.tab }) } catch { /* presentation only */ }
  }

  async function initialize() {
    s.phase = 'loading'; s.failure = null; s.notice = ''; render()
    const setup = await gadget.getSetup()
    if (!setup.connected) { s.phase = 'failure'; s.failure = { code: 'not_connected', message: 'Connect a Records datastore as RECORDS in this gadget’s Connections tab. Read access is enough.' }; render(); return }
    if (!setup.connection) { s.phase = 'failure'; s.failure = { code: code({ message: setup.error }) ?? 'unavailable', message: detail({ message: setup.error }) }; render(); return }
    s.connection = setup.connection
    const [description, model, prefs] = await Promise.all([gadget.describe(), gadget.model().catch(() => null), gadget.getState().catch(() => ({}))])
    s.description = description; s.model = model; s.prefs = plain(prefs) ? prefs : {}
    const declared = module()?.entities
    s.entities = Array.isArray(declared) && declared.length ? declared.filter(name => typeof name === 'string') : Object.keys(profile()?.entities ?? {})
    s.tab = TABS.includes(s.prefs.tab) ? s.prefs.tab : 'records'
    s.entity = s.entities.includes(s.prefs.entity) ? s.prefs.entity : s.entities[0] ?? null
    s.phase = 'ready'
    if (s.entity) await loadPage(undefined)
    else render()
    if (!s.activity.started) await startActivity(s.page?.seq)
    schedule()
  }

  async function loadPage(after) {
    s.busy = true; s.notice = ''; render()
    try {
      const page = await gadget.records({ entity: s.entity, limit: LIMITS.pageRows, ...(after ? { after } : {}) })
      if (!page.records.length && after) { s.ended = true } else { s.page = page; s.after = after; s.ended = false }
    } finally { s.busy = false }
    render()
  }

  async function selectEntity(entity) {
    s.entity = entity; s.page = null; s.history = []; s.after = undefined; s.ended = false; s.filter = ''; s.inspected = null
    await savePrefs(); await loadPage(undefined)
  }

  async function next() {
    const last = s.page?.records?.at(-1)?.id
    if (!last || s.ended) return
    s.history.push(s.after); await loadPage(last)
    if (s.ended) s.history.pop()
  }

  async function previous() {
    if (s.ended) { s.ended = false; render(); return }
    if (!s.history.length) return
    await loadPage(s.history.pop())
  }

  async function lookup() {
    const id = s.lookup.trim().toLowerCase()
    if (!isUuid(id)) { s.notice = 'Enter a complete record ID (a UUID).'; render(); return }
    const page = await gadget.records({ id, limit: 1 })
    if (!page.records.length) { s.notice = `No record ${id} is visible in this datastore.`; render(); return }
    s.inspected = page.records[0]; render()
  }

  async function startActivity(seq) {
    s.activity = { cursor: null, epoch: undefined, items: [], note: '', started: true }
    if (Number.isSafeInteger(seq)) { s.activity.cursor = seq; s.activity.epoch = s.page?.permission_epoch; return }
    const page = await gadget.records({ limit: 1 })
    s.activity.cursor = page.seq; s.activity.epoch = page.permission_epoch
  }

  async function pollActivity() {
    if (s.phase !== 'ready' || s.activity.cursor === null) return
    let batch
    try { batch = await gadget.changes(s.activity.cursor, s.activity.epoch) } catch (error) {
      if (code(error) === 'reset_required') {
        await startActivity(undefined)
        s.activity.note = 'The datastore’s permissions changed, so the feed was cleared and restarted.'
        render(); return
      }
      s.activity.note = `Could not check for changes: ${detail(error)}`; render(); return
    }
    s.activity.epoch = batch.permission_epoch
    if (batch.changes.length) {
      s.activity.items = [...batch.changes.toReversed(), ...s.activity.items].slice(0, LIMITS.activity)
      s.activity.cursor = batch.cursor
      s.activity.note = ''
      render()
    }
  }

  function schedule() {
    if (!timers || disposed || timer) return
    timer = setTimeout(async () => {
      timer = null
      if (doc.visibilityState !== 'hidden') await pollActivity().catch(() => {})
      schedule()
    }, ACTIVITY_MS)
  }

  // ---------------------------------------------------------------- rendering

  function render() {
    if (disposed) return
    root.replaceChildren()
    root.className = s.phase === 'ready' ? 'app' : ''
    if (s.phase !== 'ready') { renderState(); return }
    renderHeader(); renderRail()
    const work = el('section', 'workspace')
    const tabs = el('div', 'view-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Explorer areas')
    for (const tab of TABS) {
      const node = button(TAB_LABELS[tab], async () => { s.tab = tab; render(); await savePrefs() }, s.tab === tab ? 'active' : 'quiet', { role: 'tab', 'aria-selected': String(s.tab === tab) })
      tabs.append(node)
    }
    work.append(tabs)
    if (s.notice) work.append(el('div', 'notice', s.notice))
    const panel = el('div', 'panel'); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-label', TAB_LABELS[s.tab])
    ;({ records: renderRecords, model: renderModel, activity: renderActivity, connection: renderConnection })[s.tab](work, panel)
    work.append(panel); root.append(work)
    if (s.inspected) renderInspector()
  }

  function renderState() {
    const failed = s.phase === 'failure'
    const box = el('section', failed ? 'failure' : 'empty')
    const titles = { not_connected: 'Connect a Records datastore', forbidden: 'This datastore is not available to you', unavailable: 'Records is unavailable' }
    box.append(el('h2', '', failed ? titles[s.failure?.code] ?? 'Something went wrong' : 'Opening Records Explorer…'), el('p', '', failed ? s.failure?.message ?? '' : 'Loading the connected datastore.'))
    if (failed) box.append(button('Retry', initialize, 'primary'))
    root.append(box)
  }

  function renderHeader() {
    const header = el('header', 'dataset')
    const brand = el('div', 'brand'); brand.append(el('span', 'brand-index', 'REC—01'), el('div', 'mark', 'Records Explorer')); header.append(brand)
    const meta = el('div', 'meta')
    const facts = [['Datastore', s.connection.label], ['Module', `${s.connection.moduleId} v${s.connection.apiMajor}`], ['Model', profile()?.version ?? module()?.version ?? 'unknown'], ['Access', s.connection.access]]
    for (const [label, value] of facts) { const item = el('span'); item.append(el('strong', '', label + ' '), doc.createTextNode(display(value))); meta.append(item) }
    header.append(meta, el('div', 'status', 'Read-only explorer')); root.append(header)
  }

  function renderRail() {
    const rail = el('nav', 'rail'); rail.setAttribute('aria-label', 'Entities'); rail.append(el('div', 'eyebrow', 'Entities'))
    if (!s.entities.length) rail.append(el('p', 'filter-empty', 'The installed module declares no entities.'))
    for (const entity of s.entities) {
      const choice = el('button', `collection${entity === s.entity ? ' active' : ''}`); choice.type = 'button'
      if (entity === s.entity) choice.setAttribute('aria-current', 'true')
      choice.append(el('strong', '', entity), el('span', '', entityProfile(entity)?.term ?? 'declared entity'))
      choice.addEventListener('click', () => run(async () => { s.tab = 'records'; await selectEntity(entity) }))
      rail.append(choice)
    }
    root.append(rail)
  }

  function topline(work, number, title, lead) {
    const top = el('div', 'topline'); const box = el('div')
    box.append(el('div', 'section-number', number), el('h1', '', title), el('p', '', lead)); top.append(box); work.append(top)
  }

  function renderRecords(work, panel) {
    if (!s.entity) { topline(work, 'RECORDS', 'No entities', 'Nothing to browse.'); panel.append(emptyBox('No entities declared', 'This datastore’s module declares no record entities.')); return }
    topline(work, `ENTITY / ${String(s.entities.indexOf(s.entity) + 1).padStart(2, '0')}`, s.entity, 'Current reads in server ID order, 50 at a time. Pages are not a consistent snapshot.')
    const controls = el('div', 'controls')
    const lookupBox = el('div', 'control control-value'); const lookupLabel = el('label', '', 'Open record by ID'); const lookupInput = el('input')
    lookupInput.id = 'rx-lookup'; lookupLabel.htmlFor = 'rx-lookup'; lookupInput.value = s.lookup; lookupInput.placeholder = 'Record UUID'; lookupInput.autocomplete = 'off'
    lookupInput.addEventListener('input', event => { s.lookup = event.target.value })
    lookupInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); run(lookup) } })
    lookupBox.append(lookupLabel, lookupInput)
    const filterBox = el('div', 'control control-value'); const filterLabel = el('label', '', 'Filter loaded rows only'); const filterInput = el('input')
    filterInput.id = 'rx-filter'; filterLabel.htmlFor = 'rx-filter'; filterInput.value = s.filter; filterInput.type = 'search'; filterInput.placeholder = 'Text in this page'
    filterInput.addEventListener('input', event => { s.filter = event.target.value; renderTable(tableHost) })
    filterBox.append(filterLabel, filterInput)
    controls.append(el('div', 'filter-lead', 'FIND'), lookupBox, button('Open', lookup), filterBox, button('Refresh', () => loadPage(s.after)))
    panel.append(controls)
    const known = profileFields(s.entity)
    if (known.length) {
      const toggles = el('fieldset', 'columns'); toggles.append(el('legend', '', 'Columns'))
      const visible = columns(s.entity)
      for (const field of known) {
        const label = el('label', 'column-toggle'); const box = el('input'); box.type = 'checkbox'; box.checked = visible.includes(field)
        box.addEventListener('change', () => run(async () => {
          const next = box.checked ? [...visible, field] : visible.filter(item => item !== field)
          s.prefs = { ...s.prefs, columns: { ...(s.prefs.columns ?? {}), [s.entity]: known.filter(item => next.includes(item)).slice(0, LIMITS.columns) } }
          render(); await savePrefs()
        }))
        label.append(box, doc.createTextNode(` ${field}`)); toggles.append(label)
      }
      panel.append(toggles)
    }
    const tableHost = el('div'); panel.append(tableHost); renderTable(tableHost)
    const pager = el('div', 'pager')
    const count = s.ended ? 'End of records' : s.page ? `${s.page.records.length} record${s.page.records.length === 1 ? '' : 's'} on this page · page ${s.history.length + 1}` : ''
    const prev = button('Previous', previous); prev.disabled = s.busy || (!s.history.length && !s.ended)
    const nextButton = button(s.busy ? 'Loading…' : 'Next', next, 'primary'); nextButton.disabled = s.busy || s.ended || !s.page?.records?.length
    pager.append(el('span', '', count), prev, nextButton); panel.append(pager)
  }

  function renderTable(host) {
    host.replaceChildren()
    if (s.ended) { host.append(emptyBox('End of records', 'The next page was empty, so there are no more records after the last page.')); return }
    if (!s.page) { host.append(emptyBox(s.busy ? 'Loading records…' : 'No page loaded', '')); return }
    if (!s.page.records.length) { host.append(emptyBox('No records yet', `This datastore has no ${s.entity} records. Apps such as the Work Board add them.`)); return }
    const needle = s.filter.trim().toLowerCase()
    const rows = needle ? s.page.records.filter(record => JSON.stringify(record).toLowerCase().includes(needle)) : s.page.records
    const fields = columns(s.entity)
    const wrap = el('div', 'table-wrap'); const table = el('table')
    table.append(el('caption', 'sr', `${s.entity} records, current page`))
    const head = el('tr'); for (const name of ['id', 'revision', 'changed by', ...fields]) { const th = el('th', '', name); th.scope = 'col'; head.append(th) }
    const thead = el('thead'); thead.append(head); table.append(thead)
    const body = el('tbody')
    for (const record of rows) {
      const row = el('tr'); const idCell = el('td')
      idCell.append(button(shortId(record.id), () => { s.inspected = record; render() }, 'link', { 'aria-label': `Inspect record ${record.id}` })); idCell.title = display(record.id)
      row.append(idCell, el('td', '', display(record.revision)), el('td', '', actorLabel(record.updated_by)))
      for (const field of fields) { const value = display(record.data?.[field]); const cell = el('td', '', value); cell.title = value; row.append(cell) }
      body.append(row)
    }
    table.append(body); wrap.append(table); host.append(wrap)
    if (needle) host.append(el('div', 'chart-note', `${rows.length} of ${s.page.records.length} loaded rows match · the filter does not search the datastore`))
  }

  function emptyBox(title, text) { const box = el('div', 'empty'); box.append(el('h2', '', title)); if (text) box.append(el('p', '', text)); return box }

  function definitionList(entity, record) {
    const list = el('dl'); const definitions = entityProfile(entity)?.fields ?? {}
    const data = plain(record.data) ? record.data : {}
    const add = (name, value, note) => { const dt = el('dt', '', name); if (note) dt.append(el('small', 'field-note', note)); list.append(dt, el('dd', '', display(value))) }
    add('id', record.id); add('entity', record.entity); add('revision', record.revision)
    if (record.created_by) add('created by', actorLabel(record.created_by))
    if (record.updated_by) add('last changed by', actorLabel(record.updated_by))
    if (record.owner) add('owner', actorLabel(record.owner))
    for (const [name, definition] of Object.entries(definitions)) {
      const facts = [definition.type, definition.required ? 'required' : null, definition.restricted ? 'restricted' : null, Array.isArray(definition.enum) ? `one of ${definition.enum.join(', ')}` : null, definition.term].filter(Boolean).join(' · ')
      add(name, name in data ? data[name] : definition.restricted ? '(hidden: only its owner and admins see this)' : '(not returned)', facts)
    }
    for (const [name, value] of Object.entries(data)) if (!(name in definitions)) add(name, value, 'not in profile')
    return list
  }

  function renderInspector() {
    const aside = el('aside', 'inspector'); aside.setAttribute('aria-label', 'Record inspector')
    const header = el('header'); const heading = el('div'); heading.append(el('div', 'eyebrow', s.inspected.entity ?? 'record'), el('h2', '', shortId(s.inspected.id)))
    const close = button('Close', () => { s.inspected = null; render() }); header.append(heading, close); aside.append(header)
    aside.append(definitionList(s.inspected.entity, s.inspected), el('h3', '', 'JSON'))
    const raw = JSON.stringify(s.inspected, null, 2)
    aside.append(el('pre', '', raw.length > LIMITS.jsonChars ? raw.slice(0, LIMITS.jsonChars) + '\n… truncated' : raw))
    aside.addEventListener('keydown', event => { if (event.key === 'Escape') { s.inspected = null; render() } })
    root.append(aside); close.focus()
  }

  function renderModel(work, panel) {
    const p = profile()
    topline(work, 'MODEL', p?.id ?? `${s.connection.moduleId} profile`, p?.vocabulary ? `Vocabulary ${p.vocabulary.id} ${p.vocabulary.version} · profile ${p.version ?? 'unversioned'}` : 'Profile metadata published by the Records service.')
    if (!p) { panel.append(emptyBox('No model published', 'The service did not return a profile for this module. Records can still be browsed.')); return }
    for (const [entity, definition] of Object.entries(p.entities ?? {})) {
      const section = el('section', 'model-entity'); section.append(el('h2', '', entity), el('p', 'term', `Term: ${display(definition.term ?? 'none')}`))
      const table = el('table'); const head = el('tr'); for (const name of ['field', 'term', 'type', 'required', 'constraints']) { const th = el('th', '', name); th.scope = 'col'; head.append(th) }
      const thead = el('thead'); thead.append(head); table.append(thead); const body = el('tbody')
      for (const [name, field] of Object.entries(definition.fields ?? {})) {
        const constraints = Object.entries(field).filter(([key]) => !['term', 'type', 'required'].includes(key)).map(([key, value]) => `${key}: ${display(value)}`).join('; ')
        const row = el('tr'); for (const value of [name, field.term ?? '', field.type ?? '', field.required ? 'yes' : 'no', constraints]) row.append(el('td', '', display(value)))
        body.append(row)
      }
      table.append(body); const wrap = el('div', 'table-wrap'); wrap.append(table); section.append(wrap)
      const schema = s.model?.schemas?.[entity]
      if (schema) {
        section.append(button(s.showSchema[entity] ? 'Hide JSON Schema' : 'Show JSON Schema', () => { s.showSchema[entity] = !s.showSchema[entity]; render() }))
        if (s.showSchema[entity]) { const raw = JSON.stringify(schema, null, 2); section.append(el('pre', 'schema', raw.length > LIMITS.jsonChars ? raw.slice(0, LIMITS.jsonChars) + '\n… truncated' : raw)) }
      }
      panel.append(section)
    }
    const commands = module()?.commands ?? []
    const section = el('section', 'model-entity'); section.append(el('h2', '', 'Commands'))
    section.append(el('p', '', commands.length ? commands.join(', ') : 'No commands are installed.'), el('p', 'term', 'Changes are made by apps such as the Work Board; this explorer is read-only.'))
    panel.append(section)
  }

  function renderActivity(work, panel) {
    topline(work, 'ACTIVITY', 'Recent changes', 'Changes seen since you opened this explorer — not full history. Checked every 5 seconds while visible.')
    const controls = el('div', 'controls'); controls.append(el('div', 'filter-lead', 'FEED'), el('span', 'filter-empty', `From journal position ${display(s.activity.cursor)} · at most ${LIMITS.activity} kept`), button('Check now', pollActivity))
    panel.append(controls)
    if (s.activity.note) panel.append(el('div', 'notice', s.activity.note))
    if (!s.activity.items.length) { panel.append(emptyBox('No changes seen yet', 'Changes made by any gadget or client connected to this datastore appear here.')); return }
    const list = el('ol', 'activity')
    for (const change of s.activity.items) {
      const item = el('li'); const open = button(`${change.entity} ${shortId(change.record_id)}`, () => { s.inspected = { id: change.record_id, entity: change.entity, revision: change.revision, updated_by: change.actor, data: change.data }; render() }, 'link')
      item.append(el('span', 'seq', `#${display(change.seq)}`), open, el('span', 'summary', `revision ${display(change.revision)}${change.actor ? ` by ${actorLabel(change.actor)}` : ''} · ${display(change.data?.title ?? change.data?.name ?? '')}`))
      list.append(item)
    }
    panel.append(list)
  }

  function renderConnection(work, panel) {
    topline(work, 'CONNECTION', s.connection.label, 'How this gadget reaches the datastore. No credentials are held by the gadget.')
    const list = el('dl', 'connection')
    for (const [label, value] of [['Datastore', s.connection.datastore], ['Connection', s.connection.binding], ['URL', s.connection.url], ['Module', `${s.connection.moduleId} v${s.connection.apiMajor}`], ['Scopes', (s.connection.scopes ?? []).join(', ')], ['Access', s.connection.access], ['Permission epoch', s.description?.permission_epoch]]) {
      list.append(el('dt', '', label), el('dd', '', display(value)))
    }
    panel.append(list, el('p', 'connection-note', 'Records stay in the datastore when this explorer is removed or disconnected. Other gadgets connected to the same datastore see the same records.'))
  }

  const ready = run(initialize)
  return {
    state: s,
    refresh: () => run(initialize),
    ready,
    pollActivity: () => run(pollActivity),
    dispose() { disposed = true; if (timer) clearTimeout(timer) },
  }
}
