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

export class History {
  constructor({ getState, setState, limit = 200 } = {}) {
    this.getState = getState;
    this.setState = setState;
    this.limit = limit;
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
    if (this.past.length > this.limit) this.past.shift();
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
