// Snapshot-based undo/redo history.
//
// `record()` is meant to be called on every user-driven state mutation —
// a slider tick, a spinner-arrow click, a curve point drag, a checkbox
// toggle. Consecutive calls from the same control collapse into a single
// undo step, so dragging a slider (which fires dozens of `input` events)
// produces one entry, not one per pixel. A call from a different control
// closes the previous burst first, so two edits made in quick succession to
// two different widgets stay separately undoable.

const COALESCE_MS = 500;

// A snapshot is a whole serialized effect, and every one of them carries a
// full copy of each material's WGSL. The built-in presets measure 2–7 KB, so
// the entry limit alone costs ~1.3 MB of string — not worth worrying about.
// An effect with large hand-written shaders can be an order of magnitude
// bigger, though, so cap total retained characters as well and drop the
// oldest entries once it is exceeded. In normal use this never binds.
const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_CHARS = 8 * 1024 * 1024;

export class History {
  constructor({ getState, setState, limit = DEFAULT_LIMIT, maxChars = DEFAULT_MAX_CHARS } = {}) {
    this.getState = getState;
    this.setState = setState;
    this.limit = limit;
    this.maxChars = maxChars;
    this.past = [];
    this.future = [];
    this.pendingBefore = null;
    this.pendingSource = null;
    this.timer = null;
  }

  /**
   * `source` identifies the control driving the change — any stable value
   * will do; the widget element itself is the usual choice. A burst only
   * keeps coalescing while the source stays the same.
   */
  record(source = null) {
    if (this.pendingBefore !== null && source !== this.pendingSource) this.flush();
    if (this.pendingBefore === null) {
      this.pendingBefore = this.getState();
      this.pendingSource = source;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), COALESCE_MS);
  }

  /** Close out the in-flight burst now, e.g. right before undo/redo runs. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const before = this.pendingBefore;
    this.pendingBefore = null;
    this.pendingSource = null;
    if (before === null) return;
    if (before === this.getState()) return; // burst was a no-op (e.g. a UI-only click)
    // Only a burst that actually changed something invalidates the redo
    // stack. Clearing in record() instead would also drop it on every click
    // of a button that turned out to be state-neutral.
    this.future = [];
    this.past.push(before);
    this.trim();
  }

  /**
   * Enforce the entry and character budgets, dropping oldest-first. Runs once
   * per committed undo step rather than per input event, so walking both
   * stacks to total their sizes is cheap. The newest entry is always kept —
   * a single oversized effect should shorten history, not disable undo.
   */
  trim() {
    while (this.past.length > this.limit) this.past.shift();
    let total = 0;
    for (const s of this.past) total += s.length;
    for (const s of this.future) total += s.length;
    while (this.past.length > 1 && total > this.maxChars) total -= this.past.shift().length;
  }

  undo() {
    this.flush();
    const before = this.past.pop();
    if (before === undefined) return false;
    this.future.push(this.getState());
    this.setState(before);
    return true;
  }

  redo() {
    this.flush();
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.getState());
    this.setState(next);
    return true;
  }
}
