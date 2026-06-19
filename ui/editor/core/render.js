import { highlightLines } from "../syntax/highlight.js";

// Renders editor state into the DOM. Cursor and selection are rendered as
// absolute-positioned overlays inside each line, so they inherit positioning
// without DOM math at the document level.

export function createRenderer({ root, content, state }) {
  let lineHeight = 20;
  let charWidth = 8;

  function measure() {
    // Bare span so .line's `min-width: 100%` rule does not stretch the probe
    // to the content's width and inflate the measured character width.
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.left = "-9999px";
    probe.style.top = "-9999px";
    probe.style.whiteSpace = "pre";
    probe.textContent = "M".repeat(100);
    content.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    if (rect.width > 0)  charWidth  = rect.width / 100;
    if (rect.height > 0) lineHeight = rect.height;
    probe.remove();
  }

  function comparePos(a, b) {
    if (a.line !== b.line) return a.line - b.line;
    return a.col - b.col;
  }

  function orderedSelection() {
    if (!state.selection) return null;
    const { anchor, head } = state.selection;
    if (comparePos(anchor, head) === 0) return null;
    return comparePos(anchor, head) < 0
      ? { start: anchor, end: head }
      : { start: head, end: anchor };
  }

  function renderLines() {
    const fragment = document.createDocumentFragment();
    const sel = orderedSelection();
    const html = highlightLines(state.lines, state.language);

    const bps = state.breakpoints;
    for (let i = 0; i < state.lines.length; i++) {
      const div = document.createElement("div");
      div.className = "line";
      if (i === state.cursor.line && !sel) div.classList.add("active-line");
      if (bps && bps.has(i)) div.classList.add("bp");
      if (state.debugLine === i) div.classList.add("debug-line");
      div.innerHTML = html[i] ?? "&nbsp;";
      fragment.appendChild(div);
    }

    content.replaceChildren(fragment);
  }

  // Returns the line index if (clientX, clientY) falls in the gutter (left of
  // the text), else -1 — used to toggle breakpoints.
  function gutterLineAt(clientX, clientY) {
    const lineEls = content.querySelectorAll(".line");
    for (let i = 0; i < lineEls.length; i++) {
      const r = lineEls[i].getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return clientX < r.left ? i : -1;
    }
    return -1;
  }

  function renderSelection() {
    const sel = orderedSelection();
    if (!sel) return;

    for (let i = sel.start.line; i <= sel.end.line; i++) {
      const lineEl = content.children[i];
      if (!lineEl) continue;

      const startCol = i === sel.start.line ? sel.start.col : 0;
      const endCol   = i === sel.end.line   ? sel.end.col   : state.lines[i].length;
      const trailingNewline = i < sel.end.line ? 0.5 : 0;

      const block = document.createElement("div");
      block.className = "code-editor-selection";
      block.style.left   = (startCol * charWidth) + "px";
      block.style.top    = "0";
      block.style.width  = ((endCol - startCol + trailingNewline) * charWidth) + "px";
      block.style.height = lineHeight + "px";
      lineEl.appendChild(block);
    }
  }

  function renderCursor() {
    const lineEl = content.children[state.cursor.line];
    if (!lineEl) return;

    const cursor = document.createElement("div");
    cursor.className = "code-editor-cursor";
    cursor.style.left   = (state.cursor.col * charWidth) + "px";
    cursor.style.top    = "0";
    cursor.style.height = lineHeight + "px";
    lineEl.appendChild(cursor);
  }

  function ensureCursorVisible() {
    const lineEl = content.children[state.cursor.line];
    if (!lineEl) return;

    const top    = lineEl.offsetTop;
    const bottom = top + lineHeight;
    const left   = lineEl.offsetLeft + state.cursor.col * charWidth;
    const right  = left + 4;

    if (top < root.scrollTop) {
      root.scrollTop = top;
    } else if (bottom > root.scrollTop + root.clientHeight) {
      root.scrollTop = bottom - root.clientHeight;
    }

    if (left < root.scrollLeft) {
      root.scrollLeft = left;
    } else if (right > root.scrollLeft + root.clientWidth) {
      root.scrollLeft = right - root.clientWidth;
    }
  }

  // Tint every occurrence of the word currently hovered (state.hoverWord),
  // VSCode "occurrences" style. Translucent overlays behind the text.
  function renderWordHighlights() {
    const word = state.hoverWord;
    if (!word || word.length < 1) return;
    const re = new RegExp("(?<![A-Za-z0-9_])" + word + "(?![A-Za-z0-9_])", "g");
    for (let i = 0; i < state.lines.length; i++) {
      const lineEl = content.children[i];
      if (!lineEl) continue;
      const text = state.lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const block = document.createElement("div");
        block.className = "code-editor-word-hl";
        block.style.left = m.index * charWidth + "px";
        block.style.top = "0";
        block.style.width = word.length * charWidth + "px";
        block.style.height = lineHeight + "px";
        lineEl.appendChild(block);
        if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
      }
    }
  }

  const OPENERS = { "(": ")", "[": "]", "{": "}" };
  const CLOSERS = { ")": "(", "]": "[", "}": "{" };

  function posToOffset(line, col) {
    let off = 0;
    for (let i = 0; i < line && i < state.lines.length; i++) off += state.lines[i].length + 1;
    return off + col;
  }
  function offsetToPos(off) {
    let i = 0;
    while (i < state.lines.length && off > state.lines[i].length) {
      off -= state.lines[i].length + 1;
      i++;
    }
    if (i >= state.lines.length) i = state.lines.length - 1;
    return { line: i, col: Math.max(0, off) };
  }
  function findEnclosing(text, pos) {
    const depth = { "(": 0, "[": 0, "{": 0 };
    let openIdx = -1, openCh = null;
    const back = Math.max(0, pos - 100000);
    for (let i = pos - 1; i >= back; i--) {
      const c = text[i];
      if (c === ")" || c === "]" || c === "}") depth[CLOSERS[c]]++;
      else if (c === "(" || c === "[" || c === "{") {
        if (depth[c] > 0) depth[c]--;
        else { openIdx = i; openCh = c; break; }
      }
    }
    if (openIdx < 0) return null;
    const close = OPENERS[openCh];
    let d = 0, closeIdx = -1;
    const fwd = Math.min(text.length, openIdx + 100000);
    for (let i = openIdx + 1; i < fwd; i++) {
      const c = text[i];
      if (c === openCh) d++;
      else if (c === close) { if (d > 0) d--; else { closeIdx = i; break; } }
    }
    if (closeIdx < 0) return null;
    return { open: openIdx, close: closeIdx };
  }

  // Outline the bracket pair enclosing the caret (themeable via --ce-bracket).
  function renderBrackets() {
    const text = state.lines.join("\n");
    const pair = findEnclosing(text, posToOffset(state.cursor.line, state.cursor.col));
    if (!pair) return;
    for (const off of [pair.open, pair.close]) {
      const p = offsetToPos(off);
      const lineEl = content.children[p.line];
      if (!lineEl) continue;
      const box = document.createElement("div");
      box.className = "code-editor-bracket";
      box.style.left = p.col * charWidth + "px";
      box.style.top = "0";
      box.style.width = charWidth + "px";
      box.style.height = lineHeight + "px";
      lineEl.appendChild(box);
    }
  }

  // Extra cursors (multi-cursor) and their selections.
  function renderMultiCarets() {
    if (!state.carets || !state.carets.length) return;
    for (const c of state.carets) {
      if (c.selection) {
        const ord = comparePos(c.selection.anchor, c.selection.head) <= 0
          ? { start: c.selection.anchor, end: c.selection.head }
          : { start: c.selection.head, end: c.selection.anchor };
        for (let i = ord.start.line; i <= ord.end.line; i++) {
          const el = content.children[i];
          if (!el) continue;
          const sc = i === ord.start.line ? ord.start.col : 0;
          const ec = i === ord.end.line ? ord.end.col : state.lines[i].length;
          const trail = i < ord.end.line ? 0.5 : 0;
          const b = document.createElement("div");
          b.className = "code-editor-selection";
          b.style.left = sc * charWidth + "px";
          b.style.top = "0";
          b.style.width = (ec - sc + trail) * charWidth + "px";
          b.style.height = lineHeight + "px";
          el.appendChild(b);
        }
      }
      const le = content.children[c.cursor.line];
      if (le) {
        const car = document.createElement("div");
        car.className = "code-editor-cursor code-editor-cursor-extra";
        car.style.left = c.cursor.col * charWidth + "px";
        car.style.top = "0";
        car.style.height = lineHeight + "px";
        le.appendChild(car);
      }
    }
  }

  function render() {
    renderLines();
    renderWordHighlights();
    renderSelection();
    renderMultiCarets();
    renderCursor();
    renderBrackets();
    ensureCursorVisible();
  }

  function pointToPos(clientX, clientY) {
    const lineEls = content.querySelectorAll(".line");
    if (lineEls.length === 0) return { line: 0, col: 0 };

    let lineIdx = lineEls.length - 1;
    for (let i = 0; i < lineEls.length; i++) {
      const rect = lineEls[i].getBoundingClientRect();
      if (clientY < rect.bottom) {
        lineIdx = i;
        break;
      }
    }

    const lineEl = lineEls[lineIdx];
    const lineRect = lineEl.getBoundingClientRect();
    const relX = clientX - lineRect.left;
    let col = Math.round(relX / charWidth);
    col = Math.max(0, Math.min(col, state.lines[lineIdx].length));

    return { line: lineIdx, col };
  }

  // Pixel position of the caret in the SCROLLER's content coordinate space
  // (i.e. NOT adjusted for scroll). The autocomplete popup is an absolutely
  // positioned child of the scroller, so it shares this coordinate system and
  // scrolls along with the content — subtracting scrollTop/Left here would
  // misplace it once the document is scrolled (the long-file bug).
  function caretCoords() {
    const lineEl = content.children[state.cursor.line];
    if (!lineEl) return { left: 0, top: 0, bottom: lineHeight };
    const left = content.offsetLeft + lineEl.offsetLeft + state.cursor.col * charWidth;
    const top = content.offsetTop + lineEl.offsetTop;
    return { left, top, bottom: top + lineHeight };
  }

  measure();

  return {
    render,
    measure,
    pointToPos,
    gutterLineAt,
    caretCoords,
    get lineHeight() { return lineHeight; },
    get charWidth()  { return charWidth; },
  };
}
