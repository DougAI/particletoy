import assert from 'node:assert/strict';
import { createMobileWorkspace, MOBILE_VIEW_KEY, normalizeMobileView } from './mobile-layout.js';

function tab(view) {
  const listeners = new Map();
  return {
    dataset: { mobileView: view },
    classList: { active: false, toggle(_name, value) { this.active = value; } },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    focused: false,
    focus() { this.focused = true; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    click() { listeners.get('click')?.(); },
    keydown(key) {
      let prevented = false;
      listeners.get('keydown')?.({ key, preventDefault() { prevented = true; } });
      return prevented;
    },
    tabIndex: 0,
  };
}

assert.equal(normalizeMobileView('code'), 'code');
assert.equal(normalizeMobileView('unknown'), 'preview');

const body = { dataset: {} };
const tabs = ['preview', 'inspect', 'code'].map(tab);
const values = new Map([[MOBILE_VIEW_KEY, 'inspect']]);
const storage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, value); },
};
const mediaQuery = { matches: true, addEventListener() {}, removeEventListener() {} };
const changes = [];
const workspace = createMobileWorkspace({ body, tabs, mediaQuery, storage,
  onChange: (view, mobile) => changes.push([view, mobile]) });

assert.equal(body.dataset.mobileView, 'inspect');
assert.equal(tabs[1].attrs['aria-selected'], 'true');
tabs[2].click();
assert.equal(workspace.view, 'code');
assert.equal(body.dataset.mobileView, 'code');
assert.equal(values.get(MOBILE_VIEW_KEY), 'code');
assert.equal(tabs[2].classList.active, true);
assert.equal(tabs[2].keydown('ArrowRight'), true);
assert.equal(workspace.view, 'preview');
assert.equal(tabs[0].focused, true);

mediaQuery.matches = false;
workspace.setView('preview', { persist: false });
assert.equal('mobileView' in body.dataset, false);
assert.deepEqual(changes.at(-1), ['preview', false]);
workspace.destroy();

console.log('mobile workspace controller: ok');
