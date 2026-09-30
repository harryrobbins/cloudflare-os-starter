/* global gadget */
export async function exportDiagram(result, format, scale = 2) {
  const file = await gadget.renderDiagram({ source: result.source, language: result.language, layout: result.layout, theme: Number(result.theme), sketch: result.sketch, format, scale });
  const url = URL.createObjectURL(new Blob([file.data], { type: file.contentType }));
  const dialog = document.createElement('dialog'); dialog.className = 'export-file-dialog';
  const title = document.createElement('h2'); title.textContent = 'Your file is ready';
  const note = document.createElement('p'); note.textContent = 'Use the Workshop Export menu above this gadget for direct downloads. You can also open this prepared file in a new tab and save it there.';
  const anchor = document.createElement('a'); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener'; anchor.textContent = `Open ${file.filename}`;
  const close = document.createElement('button'); close.textContent = 'Close'; close.addEventListener('click', () => dialog.close());
  dialog.append(title, note, anchor, document.createElement('br'), close); document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => { URL.revokeObjectURL(url); dialog.remove(); }, { once: true });
}
