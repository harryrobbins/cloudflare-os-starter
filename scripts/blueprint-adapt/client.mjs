// Shared extension UI, bundled into each blueprint's client.lib.js.
// Only the explicit domain methods supplied by the entry are exposed to custom actions.
export function mountAdapt(adapt, { gadget, methods, ready = Promise.resolve(), refresh = async () => {} }) {
  const config = adapt && typeof adapt === 'object' ? adapt : {};
  let mounted = false;
  return Promise.resolve(ready).then(async () => {
    if (mounted) return;
    mounted = true;
    if (typeof config.title === 'string' && config.title.trim()) document.title = config.title;
    if (typeof config.styles === 'string' && config.styles) {
      const style = document.createElement('style');
      style.dataset.gadgetAdapt = 'styles';
      style.textContent = config.styles;
      document.head.append(style);
    }
    const region = document.createElement('aside');
    region.dataset.gadgetAdapt = 'actions';
    region.setAttribute('aria-label', typeof config.actionLabel === 'string' ? config.actionLabel : 'Extra actions');
    region.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:900;display:flex;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 24px);padding:8px;background:Canvas;color:CanvasText;border:1px solid ButtonBorder;border-radius:8px;font:14px system-ui';
    const status = document.createElement('span');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const notify = (message) => { status.textContent = String(message).slice(0, 500); region.hidden = false; };
    const app = Object.freeze({
      ...Object.fromEntries(methods.map(name => [name, (...args) => gadget[name](...args)])),
      refresh, notify,
    });
    const ids = new Set();
    if (config.actions !== undefined && !Array.isArray(config.actions)) console.warn('adapt.actions must be an array');
    for (const action of Array.isArray(config.actions) ? config.actions : []) {
      if (!action || typeof action.id !== 'string' || !action.id.trim() || ids.has(action.id) || typeof action.label !== 'string' || !action.label.trim() || typeof action.run !== 'function') {
        console.warn('Ignoring invalid or duplicate adapt action', action?.id);
        continue;
      }
      ids.add(action.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      if (typeof action.title === 'string') button.title = action.title;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await action.run(app); }
        catch (error) { notify(error?.message ?? error); }
        finally { button.disabled = false; }
      });
      region.append(button);
    }
    region.append(status);
    region.hidden = ids.size === 0;
    document.body.append(region);
    if (typeof config.onReady === 'function') {
      try { await config.onReady(app); }
      catch (error) { notify(error?.message ?? error); }
    }
    return app;
  });
}
