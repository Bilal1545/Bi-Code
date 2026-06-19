import { createBuffer } from "./buffer.js";
import { createHistory } from "./history.js";
import { createRenderer } from "./render.js";
import { attachInput } from "./input.js";
import { createAutocomplete } from "./autocomplete.js";
import { createFind } from "./find.js";
import { loadLanguage } from "../syntax/highlight.js";
import { normalizeLanguage, injectionLanguages } from "../syntax/languages.js";

export function createEditor({ root, content }) {
  const state = {
    lines: [""],
    cursor: { line: 0, col: 0 },
    selection: null,
    language: null,
    hoverWord: "",
    carets: [], // extra cursors (multi-cursor); primary is cursor/selection
    breakpoints: new Set(), // 0-based line numbers
    debugLine: null,        // 0-based line currently paused on
  };

  const listeners = Object.create(null);
  function on(name, fn) {
    (listeners[name] ||= []).push(fn);
  }
  function emit(name, data) {
    listeners[name]?.forEach((fn) => fn(data));
  }

  const buffer = createBuffer(state);
  const history = createHistory(state);
  const renderer = createRenderer({ root, content, state });
  const smoothScroll = createSmoothScroll(root);

  let saveHandler = null;
  let langToken = 0;

  function render() {
    renderer.render();
    emit("change", buffer.getText());
    emit("cursorChange", { ...state.cursor });
  }

  function setContent(text) {
    const value = text ?? "";
    state.lines = value.split("\n");
    if (state.lines.length === 0) state.lines = [""];
    state.cursor = { line: 0, col: 0 };
    state.selection = null;
    history.reset();
    render();
  }

  function setCursor(pos) {
    if (!pos) return;
    const line = Math.max(0, Math.min(pos.line | 0, state.lines.length - 1));
    const col = Math.max(0, Math.min(pos.col | 0, state.lines[line].length));
    state.cursor = { line, col };
    state.selection = null;
    render();
  }

  function setBreakpoints(lines) {
    state.breakpoints = new Set(lines || []);
    render();
  }
  function setDebugLine(line) {
    state.debugLine = line == null ? null : line;
    if (state.debugLine != null) setCursor({ line: state.debugLine, col: 0 });
    else render();
  }

  function getSelection() {
    return state.selection
      ? { anchor: { ...state.selection.anchor }, head: { ...state.selection.head } }
      : null;
  }
  function setSelection(sel) {
    if (sel && sel.anchor && sel.head) {
      state.selection = { anchor: { ...sel.anchor }, head: { ...sel.head } };
      state.cursor = { ...sel.head };
    }
    render();
  }

  function setLanguage(lang) {
    const normalized = normalizeLanguage(lang);
    state.language = normalized;
    if (normalized) {
      const token = ++langToken;
      loadLanguage(normalized).then((entry) => {
        if (entry && token === langToken) render();
        // Preload embedded grammars (e.g. CSS/JS inside HTML) and re-render as
        // each one arrives so injected regions colour in without a reparse.
        for (const inj of injectionLanguages(normalized)) {
          loadLanguage(inj).then((e) => { if (e && token === langToken) render(); });
        }
      });
    }
    render();
  }

  const autocomplete = createAutocomplete({
    root,
    state,
    buffer,
    history,
    renderer,
    render,
    getLanguage: () => state.language,
  });

  const find = createFind({ root, state, buffer, history, render });

  attachInput({
    root,
    state,
    buffer,
    history,
    renderer,
    render,
    autocomplete,
    onSave: () => saveHandler?.(),
    onFind: (replaceMode) => find.open(replaceMode),
    onGutterClick: (line) => emit("breakpoint", line),
  });

  render();

  // ----- editing actions exposed for the menu bar -----
  function selectAll() {
    const last = state.lines.length - 1;
    state.selection = {
      anchor: { line: 0, col: 0 },
      head: { line: last, col: state.lines[last].length },
    };
    state.cursor = { ...state.selection.head };
    render();
  }
  function selectLine() {
    const line = state.cursor.line;
    state.selection = {
      anchor: { line, col: 0 },
      head: { line, col: state.lines[line].length },
    };
    state.cursor = { ...state.selection.head };
    render();
  }
  function undo() { if (history.undo()) render(); }
  function redo() { if (history.redo()) render(); }
  async function copy() {
    const t = buffer.getSelectedText();
    if (t) { try { await navigator.clipboard.writeText(t); } catch (e) { /* ignore */ } }
  }
  async function cut() {
    const t = buffer.getSelectedText();
    if (!t) return;
    try { await navigator.clipboard.writeText(t); } catch (e) { /* ignore */ }
    history.record("cut");
    buffer.deleteSelection();
    render();
  }
  async function paste() {
    let t = "";
    try { t = await navigator.clipboard.readText(); } catch (e) { return; }
    if (!t) return;
    history.record("paste");
    buffer.insertText(t);
    render();
  }

  function transformCase(mode) {
    if (!state.selection) {
      const w = buffer.wordRangeAt(state.cursor);
      if (!w) return;
      state.selection = { anchor: w.start, head: w.end };
    }
    const sel = buffer.orderedSelection();
    if (!sel) return;
    const text = buffer.getRange(sel.start, sel.end);
    let out;
    if (mode === "upper") out = text.toUpperCase();
    else if (mode === "lower") out = text.toLowerCase();
    else out = text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    history.record("case");
    state.selection = { anchor: sel.start, head: sel.end };
    buffer.insertText(out);
    state.selection = { anchor: { ...sel.start }, head: { ...state.cursor } };
    render();
  }

  // ----- multi-cursor -----
  function caretPositions() {
    return [{ ...state.cursor }, ...state.carets.map((c) => ({ ...c.cursor }))];
  }
  function hasCaretAt(p) {
    if (p.line === state.cursor.line && p.col === state.cursor.col) return true;
    return state.carets.some((c) => c.cursor.line === p.line && c.cursor.col === p.col);
  }
  function addCaret(p) {
    if (p.line < 0 || p.line > state.lines.length - 1) return;
    const pos = { line: p.line, col: Math.min(p.col, state.lines[p.line].length) };
    if (hasCaretAt(pos)) return;
    state.carets.push({ cursor: pos, selection: null });
  }
  function addCursorBelow() {
    const b = caretPositions().reduce((a, x) => (x.line > a.line ? x : a));
    addCaret({ line: b.line + 1, col: b.col });
    render();
  }
  function addCursorAbove() {
    const t = caretPositions().reduce((a, x) => (x.line < a.line ? x : a));
    addCaret({ line: t.line - 1, col: t.col });
    render();
  }
  function addCaretAt(pos) { addCaret(pos); render(); }
  function clearMultiCursor() {
    if (state.carets.length) { state.carets = []; render(); return true; }
    return false;
  }
  function addNextOccurrence() {
    if (!state.selection) {
      const w = buffer.wordRangeAt(state.cursor);
      if (!w) return;
      state.selection = { anchor: w.start, head: w.end };
      state.cursor = { ...w.end };
      render();
      return;
    }
    const sel = buffer.orderedSelection();
    const term = buffer.getRange(sel.start, sel.end);
    if (!term) return;
    const text = buffer.getText();
    const heads = [buffer.posToOffset(state.cursor), ...state.carets.map((c) => buffer.posToOffset(c.cursor))];
    let idx = text.indexOf(term, Math.max(...heads));
    if (idx < 0) idx = text.indexOf(term, 0);
    if (idx < 0) return;
    const start = buffer.offsetToPos(idx);
    const end = buffer.offsetToPos(idx + term.length);
    if (hasCaretAt(end)) return;
    state.carets.push({ cursor: end, selection: { anchor: start, head: end } });
    state.cursor = end;
    state.selection = { anchor: start, head: end };
    render();
  }

  return {
    setContent,
    getContent: () => buffer.getText(),
    getCursor: () => ({ ...state.cursor }),
    getSelectedText: () => buffer.getSelectedText(),
    wordAtCursor: () => {
      const w = buffer.wordRangeAt(state.cursor);
      return w ? buffer.getRange(w.start, w.end) : "";
    },
    setCursor,
    getSelection,
    setSelection,
    setBreakpoints,
    setDebugLine,
    setSmoothScroll: smoothScroll.setEnabled,
    setLanguage,
    selectAll,
    selectLine,
    undo,
    redo,
    copy,
    cut,
    paste,
    transformCase,
    addCursorBelow,
    addCursorAbove,
    addCaretAt,
    addNextOccurrence,
    clearMultiCursor,
    openFind: (replaceMode) => find.open(replaceMode),
    on,
    registerSaveHandler: (fn) => { saveHandler = fn; },
  };
}

// Inertial wheel scrolling that always lands on integer pixel offsets. CSS
// `scroll-behavior: smooth` leaves the scroller at fractional offsets mid- and
// post-animation, which makes Chromium rasterize text blurry until the next
// scroll snaps it back to a whole pixel — animating in JS and rounding every
// frame avoids that entirely.
function createSmoothScroll(root) {
  let enabled = false;
  let targetTop = 0;
  let targetLeft = 0;
  let rafId = null;

  function onWheel(e) {
    if (e.ctrlKey) return; // let ctrl+wheel (zoom) pass through
    // Let the autocomplete popup scroll itself.
    if (e.target && e.target.closest && e.target.closest(".code-editor-autocomplete")) return;

    const unit =
      e.deltaMode === 1 ? 20 : e.deltaMode === 2 ? root.clientHeight : 1;
    const dy = (e.shiftKey ? 0 : e.deltaY) * unit;
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) * unit;
    const maxTop = root.scrollHeight - root.clientHeight;
    const maxLeft = root.scrollWidth - root.clientWidth;

    if (!enabled) {
      // Smooth scrolling is off: take over the wheel and jump instantly so the
      // webview's own (animated) smooth scrolling can't kick in.
      e.preventDefault();
      root.scrollTop = Math.max(0, Math.min(maxTop, root.scrollTop + dy));
      root.scrollLeft = Math.max(0, Math.min(maxLeft, root.scrollLeft + dx));
      return;
    }

    e.preventDefault();
    if (rafId === null) {
      targetTop = root.scrollTop;
      targetLeft = root.scrollLeft;
    }
    targetTop = Math.max(0, Math.min(maxTop, targetTop + dy));
    targetLeft = Math.max(0, Math.min(maxLeft, targetLeft + dx));
    if (rafId === null) rafId = requestAnimationFrame(step);
  }

  function step() {
    const ease = 0.25;
    let top = root.scrollTop + (targetTop - root.scrollTop) * ease;
    let left = root.scrollLeft + (targetLeft - root.scrollLeft) * ease;
    if (Math.abs(targetTop - top) < 0.5) top = targetTop;
    if (Math.abs(targetLeft - left) < 0.5) left = targetLeft;
    root.scrollTop = Math.round(top);
    root.scrollLeft = Math.round(left);
    if (root.scrollTop === Math.round(targetTop) && root.scrollLeft === Math.round(targetLeft)) {
      rafId = null;
    } else {
      rafId = requestAnimationFrame(step);
    }
  }

  root.addEventListener("wheel", onWheel, { passive: false });

  return {
    setEnabled(v) {
      enabled = !!v;
      if (!enabled && rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}
