// Snapshot-based undo/redo history.
//
// `record()` is meant to be called on every user-driven state mutation —
// a slider tick, a spinner-arrow click, a curve point drag, a checkbox
// toggle. Calls arriving within COALESCE_MS of each other collapse into a
// single undo step, so dragging a slider (which fires dozens of `input`
// events) produces one entry, not one per pixel.

const COALESCE_MS = 500;

export class History {
  constructor({ getState, setState, limit = 200 } = {}) {
    this.getState = getState;
    this.setState = setState;
    this.limit = limit;
    this.past = [];
    this.future = [];
    this.pendingBefore = null;
    this.timer = null;
  }

  record() {
    if (this.pendingBefore === null) this.pendingBefore = this.getState();
    this.future = [];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), COALESCE_MS);
  }

  /** Close out the in-flight burst now, e.g. right before undo/redo runs. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const before = this.pendingBefore;
    this.pendingBefore = null;
    if (before === null) return;
    if (before === this.getState()) return; // burst was a no-op (e.g. a UI-only click)
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
