const examples = {
  work: {
    title: 'Studio / work', consumers: 'A board. A report. An automation.',
    description: 'An open model can power many apps. Independent developers could map Jira or Linear SDKs to work data, and Slack or Matrix clients to messaging.',
    code: 'module: work\nentities: items, projects, comments\ncommands: create_item, transition_item',
    rows: [['Launch the customer portal', 'In progress'], ['Review the onboarding flow', 'Ready'], ['Write the release notes', 'Planned']],
    added: ['Prepare the team demo', 'Planned'],
  },
  messaging: {
    title: 'Studio / messaging', consumers: 'A channel. An inbox. A digest.',
    description: 'Messages belong to the datastore. A team chat and a daily digest can use the same channels, threads and membership rules.',
    code: 'module: messaging\nentities: channels, messages, reactions\ncommands: send_message, edit_message',
    rows: [['Maya · The prototype is ready to review.', '#design'], ['Alex · Shared the updated timeline.', '#studio'], ['Sam · Thanks for the feedback!', 'Thread']],
    added: ['You · Let’s share the next iteration.', '#design'],
  },
  knowledge: {
    title: 'Studio / knowledge', consumers: 'A wiki. A handbook. A search view.',
    description: 'A future module could give documents structure and shared ownership. Rich text collaboration and search need their own implementation.',
    code: 'module: knowledge (future example)\nentities: pages, collections, revisions\ncommands: publish_page, revise_page',
    rows: [['How we work together', 'Handbook'], ['Design principles', 'Published'], ['Customer discovery notes', 'Draft']],
    added: ['A guide for the next teammate', 'Draft'],
  },
};
let active = 'work';
const added = new Set();
const add = document.querySelector('#demo-add');
add.hidden = false;
function render() {
  const item = examples[active];
  for (const [id, value] of Object.entries({ 'demo-title': item.title, 'demo-consumers': item.consumers, 'demo-description': item.description, 'demo-code': item.code })) {
    document.getElementById(id).textContent = value;
  }
  const rows = [...item.rows, ...(added.has(active) ? [item.added] : [])];
  document.querySelector('#demo-rows').replaceChildren(...rows.map(([text, badge]) => {
    const row = document.createElement('div'); row.className = 'record-row';
    const dot = document.createElement('span'); dot.className = 'record-dot';
    const label = document.createElement('span'); label.className = 'record-text'; label.textContent = text;
    const pill = document.createElement('span'); pill.className = 'pill'; pill.textContent = badge;
    row.append(dot, label, pill); return row;
  }));
  document.querySelectorAll('[data-module]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.module === active)));
  add.textContent = added.has(active) ? 'Reset this example ↺' : 'Add an example record +';
  document.querySelector('#demo-result').textContent = `${rows.length} records · ${added.has(active) ? 'example updated locally' : 'available to every connected view'}`;
}
document.querySelectorAll('[data-module]').forEach(button => button.addEventListener('click', () => { active = button.dataset.module; render(); }));
add.addEventListener('click', () => { added.has(active) ? added.delete(active) : added.add(active); render(); });
