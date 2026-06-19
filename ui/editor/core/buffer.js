// Pure text-buffer operations on the shared editor state.
// Cursor and selection live in `state`; mutations update both.

export function createBuffer(state) {
  function comparePos(a, b) {
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  }

  function orderedSelection() {
    if (!state.selection) return null;
    const { anchor, head } = state.selection;
    if (comparePos(anchor, head) === 0) return null;
    if (comparePos(anchor, head) < 0) {
      return { start: { ...anchor }, end: { ...head } };
    }
    return { start: { ...head }, end: { ...anchor } };
  }

  function getText() {
    return state.lines.join("\n");
  }

  function getRange(start, end) {
    if (start.line === end.line) {
      return state.lines[start.line].slice(start.col, end.col);
    }
    const parts = [
      state.lines[start.line].slice(start.col),
      ...state.lines.slice(start.line + 1, end.line),
      state.lines[end.line].slice(0, end.col),
    ];
    return parts.join("\n");
  }

  function getSelectedText() {
    const sel = orderedSelection();
    if (!sel) return "";
    return getRange(sel.start, sel.end);
  }

  function deleteRange(start, end) {
    const before = state.lines[start.line].slice(0, start.col);
    const after = state.lines[end.line].slice(end.col);
    state.lines.splice(start.line, end.line - start.line + 1, before + after);
    state.cursor = { ...start };
    state.selection = null;
  }

  function deleteSelection() {
    const sel = orderedSelection();
    if (!sel) return false;
    deleteRange(sel.start, sel.end);
    return true;
  }

  function insertText(text) {
    if (text == null) return;
    deleteSelection();

    const parts = text.split("\n");
    const { line, col } = state.cursor;
    const current = state.lines[line];
    const before = current.slice(0, col);
    const after = current.slice(col);

    if (parts.length === 1) {
      state.lines[line] = before + parts[0] + after;
      state.cursor.col = col + parts[0].length;
    } else {
      const head = before + parts[0];
      const tail = parts[parts.length - 1] + after;
      const middle = parts.slice(1, -1);
      state.lines.splice(line, 1, head, ...middle, tail);
      state.cursor.line = line + parts.length - 1;
      state.cursor.col = parts[parts.length - 1].length;
    }
    state.selection = null;
  }

  function backspace() {
    if (deleteSelection()) return;
    const { line, col } = state.cursor;
    if (col > 0) {
      const ln = state.lines[line];
      state.lines[line] = ln.slice(0, col - 1) + ln.slice(col);
      state.cursor.col--;
    } else if (line > 0) {
      const prev = state.lines[line - 1];
      state.cursor.col = prev.length;
      state.lines[line - 1] = prev + state.lines[line];
      state.lines.splice(line, 1);
      state.cursor.line--;
    }
  }

  function deleteForward() {
    if (deleteSelection()) return;
    const { line, col } = state.cursor;
    const ln = state.lines[line];
    if (col < ln.length) {
      state.lines[line] = ln.slice(0, col) + ln.slice(col + 1);
    } else if (line < state.lines.length - 1) {
      state.lines[line] = ln + state.lines[line + 1];
      state.lines.splice(line + 1, 1);
    }
  }

  // ----- offset <-> position helpers (used by multi-cursor & find) -----
  function posToOffset(pos) {
    let o = 0;
    for (let i = 0; i < pos.line && i < state.lines.length; i++) o += state.lines[i].length + 1;
    return o + pos.col;
  }
  function offsetToPos(off) {
    let i = 0;
    while (i < state.lines.length && off > state.lines[i].length) {
      off -= state.lines[i].length + 1;
      i++;
    }
    if (i >= state.lines.length) { i = state.lines.length - 1; off = state.lines[i].length; }
    return { line: i, col: Math.max(0, off) };
  }
  function totalLength() {
    let n = 0;
    for (const l of state.lines) n += l.length;
    return n + state.lines.length - 1;
  }
  function wordRangeAt(pos) {
    const ln = state.lines[pos.line] || "";
    const WR = /[A-Za-z0-9_$]/;
    let s = pos.col;
    let e = pos.col;
    while (s > 0 && WR.test(ln[s - 1])) s--;
    while (e < ln.length && WR.test(ln[e])) e++;
    if (s === e) return null;
    return { start: { line: pos.line, col: s }, end: { line: pos.line, col: e } };
  }

  return {
    comparePos,
    orderedSelection,
    getText,
    getRange,
    getSelectedText,
    deleteRange,
    deleteSelection,
    insertText,
    backspace,
    deleteForward,
    posToOffset,
    offsetToPos,
    totalLength,
    wordRangeAt,
  };
}
