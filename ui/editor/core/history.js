// Snapshot-based undo/redo. Consecutive edits of the same kind within
// MERGE_DELAY ms collapse into a single undo step.

const MERGE_DELAY = 500;
const MAX_DEPTH = 500;

export function createHistory(state) {
  let undoStack = [];
  let redoStack = [];
  let lastTime = 0;
  let lastKind = null;

  function snapshot() {
    return {
      lines: [...state.lines],
      cursor: { ...state.cursor },
      selection: state.selection
        ? {
            anchor: { ...state.selection.anchor },
            head: { ...state.selection.head },
          }
        : null,
    };
  }

  function apply(snap) {
    state.lines = [...snap.lines];
    state.cursor = { ...snap.cursor };
    state.selection = snap.selection
      ? {
          anchor: { ...snap.selection.anchor },
          head: { ...snap.selection.head },
        }
      : null;
  }

  function record(kind = "edit") {
    const now = Date.now();
    const merge =
      undoStack.length > 0 &&
      kind === lastKind &&
      now - lastTime < MERGE_DELAY;

    if (!merge) {
      undoStack.push(snapshot());
      if (undoStack.length > MAX_DEPTH) undoStack.shift();
      redoStack.length = 0;
    }

    lastTime = now;
    lastKind = kind;
  }

  function undo() {
    if (undoStack.length === 0) return false;
    redoStack.push(snapshot());
    apply(undoStack.pop());
    lastKind = null;
    return true;
  }

  function redo() {
    if (redoStack.length === 0) return false;
    undoStack.push(snapshot());
    apply(redoStack.pop());
    lastKind = null;
    return true;
  }

  function reset() {
    undoStack = [];
    redoStack = [];
    lastTime = 0;
    lastKind = null;
  }

  return { record, undo, redo, reset };
}
