// Keyboard and mouse input. Mutates state through buffer/history and
// asks the editor to re-render after each change.

const WORD_RE = /[A-Za-z0-9_]/;

export function attachInput({ root, state, buffer, history, renderer, render, autocomplete, onSave, onFind, onGutterClick }) {
  let dragging = false;
  let boxing = false;
  let boxAnchor = null;

  // ----- multi-cursor helpers -----
  const cloneSel = (s) => (s ? { anchor: { ...s.anchor }, head: { ...s.head } } : null);
  function dedupeCarets() {
    const seen = new Set([state.cursor.line + ":" + state.cursor.col]);
    state.carets = state.carets.filter((c) => {
      const k = c.cursor.line + ":" + c.cursor.col;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  // Run an edit op at every caret. Positions are snapshotted as offsets up
  // front; a running `shift` keeps later (higher) carets valid as earlier
  // edits change the text length.
  function multiApply(op) {
    if (!state.carets || state.carets.length === 0) { op(); return; }
    const all = [
      { cursor: { ...state.cursor }, selection: cloneSel(state.selection), primary: true },
      ...state.carets.map((c) => ({ cursor: { ...c.cursor }, selection: cloneSel(c.selection) })),
    ];
    for (const c of all) {
      c.curOff = buffer.posToOffset(c.cursor);
      if (c.selection) { c.aOff = buffer.posToOffset(c.selection.anchor); c.hOff = buffer.posToOffset(c.selection.head); }
    }
    all.sort((a, b) => a.curOff - b.curOff);
    let shift = 0;
    for (const c of all) {
      const before = buffer.totalLength();
      state.cursor = buffer.offsetToPos(c.curOff + shift);
      state.selection = c.selection
        ? { anchor: buffer.offsetToPos(c.aOff + shift), head: buffer.offsetToPos(c.hOff + shift) }
        : null;
      op();
      shift += buffer.totalLength() - before;
      c.newCursor = { ...state.cursor };
    }
    const prim = all.find((c) => c.primary);
    state.cursor = prim.newCursor;
    state.selection = null;
    state.carets = all.filter((c) => c !== prim).map((c) => ({ cursor: c.newCursor, selection: null }));
    dedupeCarets();
  }

  function moveCaretHoriz(cur, delta) {
    let { line, col } = cur;
    col += delta;
    if (col < 0) { if (line > 0) { line--; col = state.lines[line].length; } else col = 0; }
    else if (col > state.lines[line].length) { if (line < state.lines.length - 1) { line++; col = 0; } else col = state.lines[line].length; }
    return { line, col };
  }
  function moveCaretVert(cur, delta) {
    const line = Math.max(0, Math.min(cur.line + delta, state.lines.length - 1));
    return { line, col: Math.min(cur.col, state.lines[line].length) };
  }
  function moveAllCarets(kind, delta) {
    const mv = kind === "h" ? moveCaretHoriz : moveCaretVert;
    state.cursor = mv(state.cursor, delta);
    state.selection = null;
    for (const c of state.carets) { c.cursor = mv(c.cursor, delta); c.selection = null; }
    dedupeCarets();
  }
  function addCaretInput(pos) {
    if (pos.line === state.cursor.line && pos.col === state.cursor.col) return;
    if (state.carets.some((c) => c.cursor.line === pos.line && c.cursor.col === pos.col)) return;
    state.carets.push({ cursor: { ...pos }, selection: null });
    render();
  }
  // Rectangular (column) selection from boxAnchor to head: one caret/selection
  // per spanned line at the same column range.
  function applyBox(head) {
    const a = boxAnchor;
    const l0 = Math.min(a.line, head.line);
    const l1 = Math.max(a.line, head.line);
    const c0 = Math.min(a.col, head.col);
    const c1 = Math.max(a.col, head.col);
    const rows = [];
    for (let l = l0; l <= l1; l++) {
      const len = state.lines[l].length;
      rows.push({ line: l, s: Math.min(c0, len), e: Math.min(c1, len) });
    }
    const mk = (r) => (r.s !== r.e ? { anchor: { line: r.line, col: r.s }, head: { line: r.line, col: r.e } } : null);
    const first = rows[0];
    state.cursor = { line: first.line, col: first.e };
    state.selection = mk(first);
    state.carets = rows.slice(1).map((r) => ({ cursor: { line: r.line, col: r.e }, selection: mk(r) }));
    render();
  }

  function setCursor(pos, extend) {
    const next = { line: pos.line, col: pos.col };
    if (extend) {
      if (!state.selection) {
        state.selection = { anchor: { ...state.cursor }, head: next };
      } else {
        state.selection.head = next;
      }
    } else {
      state.selection = null;
    }
    state.cursor = next;
  }

  function moveLine(delta, extend) {
    const line = Math.max(0, Math.min(state.cursor.line + delta, state.lines.length - 1));
    const col = Math.min(state.cursor.col, state.lines[line].length);
    setCursor({ line, col }, extend);
  }

  function moveCol(delta, extend) {
    let { line, col } = state.cursor;
    col += delta;
    if (col < 0) {
      if (line > 0) { line--; col = state.lines[line].length; }
      else col = 0;
    } else if (col > state.lines[line].length) {
      if (line < state.lines.length - 1) { line++; col = 0; }
      else col = state.lines[line].length;
    }
    setCursor({ line, col }, extend);
  }

  function moveWord(dir, extend) {
    let { line, col } = state.cursor;
    if (dir < 0) {
      if (col === 0) {
        if (line === 0) return;
        line--;
        col = state.lines[line].length;
      } else {
        const ln = state.lines[line];
        col--;
        while (col > 0 && !WORD_RE.test(ln[col])) col--;
        while (col > 0 && WORD_RE.test(ln[col - 1])) col--;
      }
    } else {
      const ln = state.lines[line];
      if (col >= ln.length) {
        if (line === state.lines.length - 1) return;
        line++;
        col = 0;
      } else {
        while (col < ln.length && WORD_RE.test(ln[col])) col++;
        while (col < ln.length && !WORD_RE.test(ln[col])) col++;
      }
    }
    setCursor({ line, col }, extend);
  }

  function selectAll() {
    const last = state.lines.length - 1;
    state.selection = {
      anchor: { line: 0, col: 0 },
      head:   { line: last, col: state.lines[last].length },
    };
    state.cursor = { ...state.selection.head };
  }

  function selectWordAt(pos) {
    const ln = state.lines[pos.line];
    let s = pos.col;
    let e = pos.col;
    while (s > 0 && WORD_RE.test(ln[s - 1])) s--;
    while (e < ln.length && WORD_RE.test(ln[e])) e++;
    state.selection = {
      anchor: { line: pos.line, col: s },
      head:   { line: pos.line, col: e },
    };
    state.cursor = { line: pos.line, col: e };
  }

  // ----- Mouse -----

  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.focus();
    autocomplete?.close();

    const pos = renderer.pointToPos(e.clientX, e.clientY);

    // Click in the gutter (left of the text) toggles a breakpoint.
    const gl = renderer.gutterLineAt(e.clientX, e.clientY);
    if (gl >= 0) { onGutterClick?.(gl); return; }

    // Alt+Shift+drag: rectangular (column) selection.
    if (e.altKey && e.shiftKey) {
      boxing = true;
      boxAnchor = pos;
      applyBox(pos);
      return;
    }
    // Alt+Click: add another cursor.
    if (e.altKey) {
      addCaretInput(pos);
      return;
    }
    // A plain click collapses any multi-cursor state.
    if (state.carets.length) { state.carets = []; }

    // Double-click selects the word, triple-click selects the line.
    // mousedown.detail counts consecutive clicks within the OS double-click
    // threshold, so we can handle both without a separate dblclick listener.
    if (e.detail === 2) {
      selectWordAt(pos);
      dragging = false;
      render();
      return;
    }

    if (e.detail >= 3) {
      const lineLen = state.lines[pos.line].length;
      state.selection = {
        anchor: { line: pos.line, col: 0 },
        head:   { line: pos.line, col: lineLen },
      };
      state.cursor = { line: pos.line, col: lineLen };
      dragging = false;
      render();
      return;
    }

    if (e.shiftKey) {
      setCursor(pos, true);
    } else {
      state.cursor = { ...pos };
      state.selection = { anchor: { ...pos }, head: { ...pos } };
    }
    dragging = true;
    render();
  });

  window.addEventListener("mousemove", (e) => {
    if (boxing) { applyBox(renderer.pointToPos(e.clientX, e.clientY)); return; }
    if (!dragging) return;
    const pos = renderer.pointToPos(e.clientX, e.clientY);
    if (state.selection) state.selection.head = pos;
    state.cursor = { ...pos };
    render();
  });

  // Hover highlight: tint the word under the pointer and all its occurrences.
  root.addEventListener("mousemove", (e) => {
    if (dragging) return;
    const pos = renderer.pointToPos(e.clientX, e.clientY);
    const ln = state.lines[pos.line] || "";
    let word = "";
    if (pos.col < ln.length && WORD_RE.test(ln[pos.col])) {
      let s = pos.col;
      let en = pos.col;
      while (s > 0 && WORD_RE.test(ln[s - 1])) s--;
      while (en < ln.length && WORD_RE.test(ln[en])) en++;
      word = ln.slice(s, en);
    }
    if (word !== state.hoverWord) {
      state.hoverWord = word;
      render();
    }
  });

  root.addEventListener("mouseleave", () => {
    if (state.hoverWord) {
      state.hoverWord = "";
      render();
    }
  });

  window.addEventListener("mouseup", () => {
    if (boxing) { boxing = false; return; }
    if (!dragging) return;
    dragging = false;
    if (state.selection) {
      const { anchor, head } = state.selection;
      if (anchor.line === head.line && anchor.col === head.col) {
        state.selection = null;
        render();
      }
    }
  });

  // ----- Clipboard -----
  // Native copy/cut/paste events get the user's clipboard data through
  // e.clipboardData, which works on file:// pages and without the async
  // permission prompt that navigator.clipboard.readText() requires.

  root.addEventListener("copy", (e) => {
    const text = buffer.getSelectedText();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  });

  root.addEventListener("cut", (e) => {
    const text = buffer.getSelectedText();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
    history.record("cut");
    buffer.deleteSelection();
    autocomplete?.close();
    render();
  });

  root.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    history.record("paste");
    multiApply(() => buffer.insertText(text));
    autocomplete?.close();
    render();
  });

  // ----- Keyboard -----

  root.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;

    // When the suggestion popup is open it gets first dibs on navigation /
    // accept / dismiss keys (arrows, Tab, Enter, Escape).
    if (autocomplete?.isOpen() && autocomplete.onKeyDown(e)) {
      e.preventDefault();
      return;
    }

    // Escape collapses extra cursors first.
    if (e.key === "Escape" && state.carets.length) {
      e.preventDefault();
      state.carets = [];
      render();
      return;
    }

    if (mod) {
      const k = e.key.toLowerCase();

      // Ctrl/Cmd+Space manually requests suggestions at the caret.
      if (e.code === "Space") {
        e.preventDefault();
        autocomplete?.trigger();
        return;
      }

      // Find / Replace
      if (k === "f" && !e.shiftKey) { e.preventDefault(); onFind?.(false); return; }
      if (k === "h") { e.preventDefault(); onFind?.(true); return; }

      // c / x / v are intentionally not preventDefaulted here so the browser
      // dispatches the native copy / cut / paste events handled above.

      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        if (history.undo()) render();
        return;
      }
      if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        if (history.redo()) render();
        return;
      }
      if (k === "a") {
        e.preventDefault();
        selectAll();
        render();
        return;
      }
      if (k === "s") {
        e.preventDefault();
        onSave?.();
        return;
      }
      if (k === "arrowleft")  { e.preventDefault(); moveWord(-1, e.shiftKey); render(); return; }
      if (k === "arrowright") { e.preventDefault(); moveWord(+1, e.shiftKey); render(); return; }
      if (k === "home") {
        e.preventDefault();
        setCursor({ line: 0, col: 0 }, e.shiftKey);
        render();
        return;
      }
      if (k === "end") {
        e.preventDefault();
        const last = state.lines.length - 1;
        setCursor({ line: last, col: state.lines[last].length }, e.shiftKey);
        render();
        return;
      }
      return;
    }

    // With extra cursors, arrows move every caret together.
    if (state.carets.length && !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (e.key === "ArrowLeft") moveAllCarets("h", -1);
      else if (e.key === "ArrowRight") moveAllCarets("h", 1);
      else if (e.key === "ArrowUp") moveAllCarets("v", -1);
      else moveAllCarets("v", 1);
      render();
      return;
    }

    if (e.key === "ArrowLeft")  { e.preventDefault(); moveCol(-1, e.shiftKey); render(); return; }
    if (e.key === "ArrowRight") { e.preventDefault(); moveCol(+1, e.shiftKey); render(); return; }
    if (e.key === "ArrowUp")    { e.preventDefault(); moveLine(-1, e.shiftKey); render(); return; }
    if (e.key === "ArrowDown")  { e.preventDefault(); moveLine(+1, e.shiftKey); render(); return; }

    if (e.key === "Home") {
      e.preventDefault();
      autocomplete?.close();
      setCursor({ line: state.cursor.line, col: 0 }, e.shiftKey);
      render();
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      autocomplete?.close();
      const len = state.lines[state.cursor.line].length;
      setCursor({ line: state.cursor.line, col: len }, e.shiftKey);
      render();
      return;
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      autocomplete?.close();
      const page = Math.max(1, Math.floor(root.clientHeight / renderer.lineHeight));
      moveLine(e.key === "PageUp" ? -page : +page, e.shiftKey);
      render();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      history.record("delete");
      multiApply(() => buffer.backspace());
      render();
      autocomplete?.update();
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      history.record("delete");
      multiApply(() => buffer.deleteForward());
      render();
      autocomplete?.update();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      history.record("newline");
      multiApply(() => buffer.insertText("\n"));
      render();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      history.record("tab");
      multiApply(() => buffer.insertText("  "));
      render();
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      history.record(e.key === " " ? "space" : "type");
      multiApply(() => buffer.insertText(e.key));
      render();
      autocomplete?.update();
      return;
    }
  });
}
