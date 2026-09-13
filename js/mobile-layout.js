// Narrow-screen workspace navigation. The desktop editor keeps its split layout;
// phones and small tablets show one useful surface at a time.

export const MOBILE_VIEWS = ['preview', 'inspect', 'code'];
export const MOBILE_VIEW_KEY = 'particletoy.mobileView.v1';

export function normalizeMobileView(value) {
  return MOBILE_VIEWS.includes(value) ? value : 'preview';
}

/**
 * The injected dependencies keep this small controller testable without a DOM shim.
 * `tabs` are buttons whose data-mobile-view values name the target workspace.
 */
export function createMobileWorkspace({ body, tabs, mediaQuery, storage, onChange = () => {} }) {
  let saved = null;
  try { saved = storage?.getItem?.(MOBILE_VIEW_KEY); } catch { /* storage can be disabled */ }
  let view = normalizeMobileView(saved);

  const render = () => {
    if (mediaQuery.matches) body.dataset.mobileView = view;
    else delete body.dataset.mobileView;
    for (const tab of tabs) {
      const selected = tab.dataset.mobileView === view;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    onChange(view, mediaQuery.matches);
  };

  const setView = (next, { persist = true } = {}) => {
    view = normalizeMobileView(next);
    if (persist) {
      try { storage?.setItem?.(MOBILE_VIEW_KEY, view); } catch { /* storage can be disabled */ }
    }
    render();
  };

  const handlers = tabs.map((tab, index) => {
    const click = () => setView(tab.dataset.mobileView);
    const keydown = (event) => {
      let next = null;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === null) return;
      event.preventDefault();
      tabs[next].focus();
      setView(tabs[next].dataset.mobileView);
    };
    tab.addEventListener('click', click);
    tab.addEventListener('keydown', keydown);
    return [tab, click, keydown];
  });
  const mediaHandler = () => render();
  mediaQuery.addEventListener?.('change', mediaHandler);
  render();

  return {
    get view() { return view; },
    setView,
    destroy() {
      for (const [tab, click, keydown] of handlers) {
        tab.removeEventListener('click', click);
        tab.removeEventListener('keydown', keydown);
      }
      mediaQuery.removeEventListener?.('change', mediaHandler);
    },
  };
}

export function setupMobileWorkspace({ root = document, win = window } = {}) {
  const tabs = [...root.querySelectorAll('#mobile-tabs [data-mobile-view]')];
  let storage = null;
  try { storage = win.localStorage; } catch { /* storage can be disabled */ }
  return createMobileWorkspace({
    body: root.body,
    tabs,
    mediaQuery: win.matchMedia('(max-width: 760px)'),
    storage,
    onChange: () => win.dispatchEvent(new win.Event('resize')),
  });
}

export function createMobileCommandBar({ bar, toggle, mediaQuery }) {
  let open = false;
  const render = () => {
    bar.classList.toggle('mobile-actions-open', open && mediaQuery.matches);
    toggle.setAttribute('aria-expanded', String(open && mediaQuery.matches));
    toggle.setAttribute('aria-label', open ? 'Close editor actions' : 'More editor actions');
    toggle.textContent = open ? '×' : '•••';
  };
  const setOpen = (next) => { open = Boolean(next); render(); };
  const click = () => setOpen(!open);
  const keydown = (event) => { if (event.key === 'Escape' && open) setOpen(false); };
  const mediaChange = () => { if (!mediaQuery.matches) open = false; render(); };
  toggle.addEventListener('click', click);
  bar.addEventListener('keydown', keydown);
  mediaQuery.addEventListener?.('change', mediaChange);
  render();
  return {
    get open() { return open; },
    setOpen,
    destroy() {
      toggle.removeEventListener('click', click);
      bar.removeEventListener('keydown', keydown);
      mediaQuery.removeEventListener?.('change', mediaChange);
    },
  };
}

export function setupMobileCommandBar({ root = document, win = window } = {}) {
  return createMobileCommandBar({
    bar: root.getElementById('topbar'),
    toggle: root.getElementById('btn-mobile-actions'),
    mediaQuery: win.matchMedia('(max-width: 760px)'),
  });
}
