/* global gadget */
let revision = 0;
let pending;
let timer;
let saving = false;
let conflict = false;
export async function loadDraft() {
  const doc = await gadget.getDocument(); revision = doc.revision;
  return doc.drafts ? doc : null;
}
export function saveDraft(document, label) {
  pending = { document, label };
  label.textContent = 'Unsaved changes';
  clearTimeout(timer); timer = setTimeout(flush, 650);
}
async function flush() {
  if (saving || !pending || conflict) return;
  saving = true;
  const draft = pending; pending = undefined;
  try {
    draft.label.textContent = 'Saving…';
    const doc = await gadget.setDocument({ expectedRevision: revision, document: draft.document });
    revision = doc.revision;
    draft.label.textContent = pending ? 'Unsaved changes' : 'Saved in this gadget';
  } catch (error) {
    conflict = true;
    draft.label.textContent = 'Save failed — reload after copying your source';
    draft.label.title = error.message;
    const alert = document.createElement('p'); alert.setAttribute('role', 'alert');
    alert.textContent = `${error.message} Copy your source before reloading.`;
    document.querySelector('.source-panel').prepend(alert);
  } finally {
    saving = false;
    if (pending && !conflict) void flush();
  }
}
