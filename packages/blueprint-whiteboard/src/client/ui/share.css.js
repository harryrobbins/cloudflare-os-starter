// @ts-check
// CSS for the sharing and discoverability features (board menu, onboarding card, presentation
// bar, shortcuts help, templates, backup and import dialogs). Injected with the shell's CSS.

export const SHARE_CSS = String.raw`
/* Board menu button (topbar) */
.wb-board-menu { flex: none; }

/* Empty-board onboarding: centred, never covering more than it needs */
.wb-onboarding {
  left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px));
  padding: 18px 20px; display: flex; flex-direction: column; gap: 10px; z-index: 12;
}
.wb-onboarding h2 { margin: 0; font-size: 17px; }
.wb-onboarding p { margin: 0; color: var(--text-2); }
.wb-onboarding-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.wb-onboarding-actions .btn { gap: 6px; min-height: 36px; }
.wb-onboarding-dismiss { align-self: flex-end; font-size: 13px; color: var(--text-3); }

/* Presentation */
.wb-app.presenting .wb-toolbar, .wb-app.presenting .wb-history, .wb-app.presenting .wb-topbar,
.wb-app.presenting .wb-topright, .wb-app.presenting .follow-chip, .wb-app.presenting .wb-stylebar,
.wb-app.presenting .wb-minimap, .wb-app.presenting .minimap-toggle, .wb-app.presenting .wb-zoom,
.wb-app.presenting .wb-onboarding { display: none !important; }
.wb-app.presenting ~ .wb-panel, .wb-app.presenting .wb-panel { display: none !important; }
.wb-present-bar {
  left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 6px;
  padding: 4px 6px; max-width: calc(100vw - 32px); z-index: 20;
}
.wb-present-bar .btn { min-width: 40px; min-height: 40px; }
.wb-present-status { padding: 0 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Shortcuts help */
.modal.wb-help { width: min(640px, 100%); max-height: calc(100vh - 32px); padding: 0; gap: 0; }
.wb-help-head { display: flex; align-items: center; gap: 12px; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.wb-help-body { overflow-y: auto; padding: 4px 20px 20px; }
.wb-help-body h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); margin: 16px 0 6px; }
.wb-help-body table { width: 100%; border-collapse: collapse; }
.wb-help-body th { text-align: left; font-weight: 400; padding: 5px 12px 5px 0; vertical-align: top; }
.wb-help-body td { text-align: right; padding: 5px 0; white-space: nowrap; vertical-align: top; }
.wb-help-body tr + tr { border-top: 1px solid var(--border); }
kbd {
  font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 1px 6px; border-radius: 4px;
  border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--text);
}

/* Templates */
.modal.wb-templates { width: min(520px, 100%); }
.wb-template-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.wb-template { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 12px; text-align: left; }

/* Backup, import, paste text, link */
.modal.wb-backup, .modal.wb-import, .modal.wb-paste { width: min(560px, 100%); }
.wb-backup-text, .wb-import-text, .wb-paste-text {
  width: 100%; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 8px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); resize: vertical;
}
.wb-paste-text { font: inherit; }
.wb-field { display: flex; flex-direction: column; gap: 4px; }
.wb-check { display: flex; align-items: center; gap: 8px; }
.wb-check input { width: 18px; height: 18px; }
.wb-import-preview p { margin: 0 0 4px; }
.wb-import-error { color: var(--danger) !important; }
.wb-import-errors { margin: 0; padding-left: 20px; max-height: 120px; overflow-y: auto; font-size: 13px; color: var(--text-2); }
.wb-link-input { width: 100%; padding: 8px 10px; }

@media (max-width: 600px) {
  .wb-onboarding { top: auto; bottom: 76px; transform: translateX(-50%); }
  .wb-onboarding-actions .btn, .wb-onboarding-dismiss, .wb-template, .wb-present-bar .btn { min-height: 44px; }
  .wb-present-bar .btn.icon-only { min-width: 44px; }
  .wb-board-menu { min-width: 44px; min-height: 44px; }
}
`;
