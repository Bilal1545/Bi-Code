// Word-based autocomplete. Suggestions come from two sources: the active
// language's keywords and every identifier already present in the buffer.
// The popup is an absolutely-positioned overlay anchored under the caret;
// it lives outside `content` so the renderer's replaceChildren() never wipes
// it on a re-render.

import { languageKeywords } from "../syntax/languages.js";

const WORD_RE = /[A-Za-z0-9_$]/;
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
// An identifier immediately followed by "(" — covers both definitions
// (function foo(), greet()) and calls (console.log(...)).
const CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const MAX_ITEMS = 12;

// Languages whose function completions get auto-inserted "(" ")" with the
// caret parked inside.
const CALL_LANGS = new Set(["javascript", "python", "rust", "go"]);

// ----- CSS data (properties + common value sets) -----
const CSS_PROPERTIES = [
  "align-content", "align-items", "align-self", "animation", "animation-delay",
  "animation-duration", "animation-name", "background", "background-color",
  "background-image", "background-position", "background-repeat", "background-size",
  "border", "border-bottom", "border-color", "border-left", "border-radius",
  "border-right", "border-style", "border-top", "border-width", "bottom",
  "box-shadow", "box-sizing", "color", "column-gap", "content", "cursor",
  "direction", "display", "filter", "flex", "flex-basis", "flex-direction",
  "flex-flow", "flex-grow", "flex-shrink", "flex-wrap", "float", "font",
  "font-family", "font-size", "font-style", "font-weight", "gap", "grid",
  "grid-area", "grid-column", "grid-gap", "grid-row", "grid-template",
  "grid-template-columns", "grid-template-rows", "height", "justify-content",
  "justify-items", "justify-self", "left", "letter-spacing", "line-height",
  "list-style", "margin", "margin-bottom", "margin-left", "margin-right",
  "margin-top", "max-height", "max-width", "min-height", "min-width", "object-fit",
  "opacity", "outline", "overflow", "overflow-x", "overflow-y", "padding",
  "padding-bottom", "padding-left", "padding-right", "padding-top", "position",
  "right", "row-gap", "text-align", "text-decoration", "text-overflow",
  "text-shadow", "text-transform", "top", "transform", "transition",
  "transition-delay", "transition-duration", "transition-property", "user-select",
  "vertical-align", "visibility", "white-space", "width", "word-break", "z-index",
];

const CSS_GLOBAL_VALUES = ["inherit", "initial", "unset", "revert"];

const CSS_VALUES = {
  display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none", "contents", "table", "flow-root"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
  "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
  "justify-content": ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly", "start", "end", "stretch"],
  "align-items": ["stretch", "flex-start", "flex-end", "center", "baseline", "start", "end"],
  "align-content": ["stretch", "flex-start", "flex-end", "center", "space-between", "space-around"],
  "text-align": ["left", "right", "center", "justify", "start", "end"],
  "font-weight": ["normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
  "font-style": ["normal", "italic", "oblique"],
  cursor: ["pointer", "default", "text", "move", "grab", "grabbing", "not-allowed", "wait", "help", "crosshair", "auto"],
  overflow: ["visible", "hidden", "scroll", "auto", "clip"],
  "overflow-x": ["visible", "hidden", "scroll", "auto", "clip"],
  "overflow-y": ["visible", "hidden", "scroll", "auto", "clip"],
  "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
  "border-style": ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"],
  "box-sizing": ["content-box", "border-box"],
  "text-decoration": ["none", "underline", "overline", "line-through"],
  "text-transform": ["none", "capitalize", "uppercase", "lowercase"],
  "text-overflow": ["clip", "ellipsis"],
  visibility: ["visible", "hidden", "collapse"],
  float: ["left", "right", "none"],
  "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
  "user-select": ["none", "auto", "text", "all"],
  "word-break": ["normal", "break-all", "keep-all", "break-word"],
  "vertical-align": ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"],
};

export function createAutocomplete({ root, state, buffer, history, renderer, render, getLanguage }) {
  let open = false;
  let items = [];
  let selected = 0;
  let current = null; // { prefix, start, line }

  const popup = document.createElement("div");
  popup.className = "code-editor-autocomplete";
  popup.style.display = "none";
  // Keep focus in the editor and stop the document-level mousedown handler
  // (which would otherwise clear the selection / move the caret) from firing.
  popup.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const itemEl = e.target.closest(".code-editor-ac-item");
    if (!itemEl) return;
    selected = Number(itemEl.dataset.index);
    accept();
  });
  root.appendChild(popup);

  // ----- candidate gathering -----

  // CSS identifiers (properties, values) contain hyphens, so widen the word
  // boundary for CSS.
  function isWordChar(c) {
    return WORD_RE.test(c) || (getLanguage() === "css" && c === "-");
  }

  function wordBefore() {
    const ln = state.lines[state.cursor.line];
    let start = state.cursor.col;
    while (start > 0 && isWordChar(ln[start - 1])) start--;
    return { prefix: ln.slice(start, state.cursor.col), start };
  }

  // ----- CSS context -----

  // Are we typing a property name or a value? Value position = a ':' appears
  // after the last ';' / '{' on the line before the caret.
  function cssContext() {
    const before = state.lines[state.cursor.line].slice(0, state.cursor.col);
    const colon = before.lastIndexOf(":");
    const semi = before.lastIndexOf(";");
    const brace = Math.max(before.lastIndexOf("{"), before.lastIndexOf("}"));
    return colon > semi && colon > brace ? "value" : "property";
  }

  function cssCurrentProperty() {
    const before = state.lines[state.cursor.line].slice(0, state.cursor.col);
    const colon = before.lastIndexOf(":");
    if (colon < 0) return "";
    let s = colon;
    while (s > 0 && /[A-Za-z-]/.test(before[s - 1])) s--;
    return before.slice(s, colon).trim();
  }

  function buildCssCandidates(prefix) {
    const lower = prefix.toLowerCase();
    let pool, kind;
    if (cssContext() === "value") {
      pool = (CSS_VALUES[cssCurrentProperty()] || []).concat(CSS_GLOBAL_VALUES);
      kind = "value";
    } else {
      pool = CSS_PROPERTIES;
      kind = "property";
    }
    const seen = new Set();
    const matches = [];
    for (const w of pool) {
      if (seen.has(w)) continue;
      seen.add(w);
      if (w === prefix) continue;
      if (!w.toLowerCase().startsWith(lower)) continue;
      matches.push({ label: w, kind });
    }
    matches.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
    return matches.slice(0, MAX_ITEMS);
  }

  // Scan the buffer once: every identifier becomes a candidate, and any
  // identifier seen as `name(` is also remembered as callable.
  function scanBuffer() {
    const idents = new Set();
    const callables = new Set();
    for (const line of state.lines) {
      for (const m of line.matchAll(IDENT_RE)) idents.add(m[0]);
      for (const m of line.matchAll(CALL_RE)) callables.add(m[1]);
    }
    return { idents, callables };
  }

  function buildCandidates(prefix) {
    if (getLanguage() === "css") return buildCssCandidates(prefix);

    const keywords = new Set(languageKeywords(getLanguage()));
    const { idents, callables } = scanBuffer();

    const labels = new Set(keywords);
    for (const id of idents) labels.add(id);

    function classify(word) {
      if (keywords.has(word)) return "keyword";
      if (callables.has(word)) return "function";
      return "variable";
    }

    const lower = prefix.toLowerCase();
    const matches = [];
    for (const word of labels) {
      if (word === prefix) continue; // nothing to complete
      if (!word.toLowerCase().startsWith(lower)) continue;
      matches.push({ label: word, kind: classify(word) });
    }

    matches.sort((a, b) => {
      // Exact-case prefix matches rank above case-insensitive ones,
      // then shorter words, then alphabetically.
      const ca = a.label.startsWith(prefix) ? 0 : 1;
      const cb = b.label.startsWith(prefix) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (a.label.length !== b.label.length) return a.label.length - b.label.length;
      return a.label.localeCompare(b.label);
    });

    return matches.slice(0, MAX_ITEMS);
  }

  // ----- rendering -----

  function renderPopup() {
    popup.replaceChildren();
    items.forEach((item, i) => {
      const el = document.createElement("div");
      el.className = "code-editor-ac-item" + (i === selected ? " selected" : "");
      el.dataset.index = i;

      const name = document.createElement("span");
      name.className = "code-editor-ac-label";
      name.textContent = item.kind === "function" ? item.label + "()" : item.label;

      const kind = document.createElement("span");
      kind.className = "code-editor-ac-kind";
      kind.textContent = item.kind === "function" ? "fn"
        : item.kind === "keyword" ? "kw"
        : item.kind === "property" ? "prop"
        : item.kind === "value" ? "val" : "var";

      el.append(name, kind);
      popup.appendChild(el);
    });

    const { left, bottom } = renderer.caretCoords();
    popup.style.left = left + "px";
    popup.style.top = bottom + "px";
    popup.style.display = "block";

    const sel = popup.children[selected];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  // ----- public actions -----

  function refresh(manual) {
    const { prefix, start } = wordBefore();
    if (!manual && prefix.length === 0) return close();

    const cands = buildCandidates(prefix);
    if (cands.length === 0) return close();

    current = { prefix, start, line: state.cursor.line };
    items = cands;
    selected = 0;
    open = true;
    renderPopup();
  }

  function close() {
    if (!open) return;
    open = false;
    items = [];
    current = null;
    popup.style.display = "none";
  }

  function accept() {
    const item = items[selected];
    if (!item || !current) return close();

    // Replace the typed prefix with the chosen word by selecting it first;
    // insertText() deletes the selection before inserting. This handles
    // case-insensitive matches (prefix "CON" -> "console") correctly.
    history.record("autocomplete");
    state.selection = {
      anchor: { line: current.line, col: current.start },
      head:   { line: current.line, col: current.start + current.prefix.length },
    };
    buffer.insertText(item.label);

    // CSS property: write "<prop>: ;", park the caret just before the ";",
    // then immediately offer the values valid for that property.
    if (item.kind === "property") {
      const ln = state.lines[state.cursor.line];
      // don't duplicate a colon that is already there
      if (ln[state.cursor.col] !== ":") {
        buffer.insertText(": ;");
        state.cursor.col -= 1;
      }
      close();
      render();
      refresh(true);
      return;
    }

    // For functions (in call-style languages), drop in "()" and park the caret
    // inside — unless the call parens are already there.
    let openedArgs = false;
    if (item.kind === "function" && CALL_LANGS.has(getLanguage())) {
      const ln = state.lines[state.cursor.line];
      if (ln[state.cursor.col] !== "(") {
        buffer.insertText("()");
        state.cursor.col -= 1;
        openedArgs = true;
      }
    }

    close();
    render();

    // Caret now sits between the parens: surface variables to pass as args.
    if (openedArgs) refresh(true);
  }

  // Returns true when the key was consumed by the popup.
  function onKeyDown(e) {
    if (!open) return false;
    switch (e.key) {
      case "ArrowDown":
        selected = (selected + 1) % items.length;
        renderPopup();
        return true;
      case "ArrowUp":
        selected = (selected - 1 + items.length) % items.length;
        renderPopup();
        return true;
      case "Enter":
      case "Tab":
        accept();
        return true;
      case "Escape":
        close();
        return true;
      default:
        return false;
    }
  }

  return {
    isOpen: () => open,
    onKeyDown,
    update: () => refresh(false),
    trigger: () => refresh(true),
    close,
  };
}
