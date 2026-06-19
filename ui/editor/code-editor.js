import { createEditor } from "./core/editor.js";

const CSS = `
code-editor {
  display: block;
  position: relative;
  color: #d4d4d4;
  background: #1e1e1e;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 14px;
  line-height: 20px;
  overflow: auto;
  outline: none;
  cursor: text;
  -webkit-text-size-adjust: 100%;
}

code-editor .code-editor-content {
  position: relative;
  padding: 1rem 6rem 6rem 1rem;
  white-space: pre;
  min-width: min-content;
  counter-reset: line;
}

code-editor .line {
  position: relative;
  display: block;
  margin-left: 4rem;
  height: 20px;
  white-space: pre;
  min-width: 100%;
  user-select: none;
  -webkit-user-select: none;
}

code-editor .line::before {
  content: counter(line);
  counter-increment: line;
  position: absolute;
  left: -4rem;
  width: 3rem;
  padding-right: 0.5rem;
  text-align: right;
  color: #6e7681;
  user-select: none;
}

code-editor .line.active-line {
  background: rgba(255, 255, 255, 0.04);
}

code-editor .line.bp::after {
  content: "";
  position: absolute;
  left: -3.5rem;
  top: 50%;
  width: 9px;
  height: 9px;
  margin-top: -4.5px;
  border-radius: 50%;
  background: #e51400;
}
code-editor .line.debug-line {
  background: rgba(255, 196, 0, 0.16);
}
code-editor .line.debug-line::before {
  color: #ffcc00;
}

code-editor .line.active-line::before {
  color: #c9d1d9;
}

code-editor .code-editor-cursor {
  position: absolute;
  width: 2px;
  background: #d4d4d4;
  animation: code-editor-blink 1s step-end infinite;
  pointer-events: none;
  z-index: 2;
}

code-editor:not(:focus-within) .code-editor-cursor {
  background: #888;
  animation: none;
}

code-editor .code-editor-selection {
  position: absolute;
  background: rgba(64, 130, 240, 0.30);
  pointer-events: none;
  z-index: 1;
}

code-editor:not(:focus-within) .code-editor-selection {
  background: rgba(120, 120, 120, 0.25);
}

code-editor .code-editor-word-hl {
  position: absolute;
  background: var(--ce-word-hl, rgba(255, 255, 255, 0.10));
  pointer-events: none;
  z-index: 0;
  border-radius: 2px;
}

code-editor .code-editor-bracket {
  position: absolute;
  box-sizing: border-box;
  border: 1px solid var(--ce-bracket, rgba(150, 150, 150, 0.55));
  pointer-events: none;
  z-index: 1;
  border-radius: 2px;
}

@keyframes code-editor-blink {
  0%, 50%   { opacity: 1; }
  51%, 100% { opacity: 0; }
}

/* Monaco-style overlay scrollbars: thin, translucent, on both axes. */
code-editor::-webkit-scrollbar {
  width: 14px;
  height: 14px;
}
code-editor::-webkit-scrollbar-track {
  background: transparent;
}
code-editor::-webkit-scrollbar-thumb {
  background: rgba(121, 121, 121, 0.4);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: 8px;
}
code-editor::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 100, 100, 0.7);
  background-clip: padding-box;
}
code-editor::-webkit-scrollbar-thumb:active {
  background: rgba(85, 85, 85, 0.9);
  background-clip: padding-box;
}
code-editor::-webkit-scrollbar-corner {
  background: transparent;
}

code-editor .keyword1 { color: #569cd6; }
code-editor .keyword2 { color: #c586c0; }
code-editor .keyword3 { color: #4fc1ff; }
code-editor .number   { color: #b5cea8; }
code-editor .string   { color: #ce9178; }
code-editor .comment  { color: #6a9955; font-style: italic; }
code-editor .operator { color: #d4d4d4; }
code-editor .function { color: #dcdcaa; }
code-editor .type     { color: #4ec9b0; }
code-editor .error {
  text-decoration: underline wavy #f14c4c;
  text-decoration-skip-ink: none;
  text-underline-offset: 2px;
}

code-editor .code-editor-cursor-extra { background: #ffcc66; }

code-editor .code-editor-find {
  position: absolute;
  top: 8px;
  right: 18px;
  z-index: 12;
  background: var(--bg-alt, #252526);
  border: 1px solid var(--border-light, #454545);
  border-radius: 5px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  user-select: none;
}
code-editor .code-editor-find:not(.with-replace) .cef-row:nth-child(2) { display: none; }
code-editor .cef-row { display: flex; align-items: center; gap: 4px; }
code-editor .cef-input {
  width: 200px;
  background: var(--input-bg, #3c3c3c);
  color: var(--fg, #d4d4d4);
  border: 1px solid var(--border-light, #3c3c3c);
  border-radius: 3px;
  padding: 3px 6px;
  font-family: inherit;
  font-size: 12px;
}
code-editor .cef-input:focus { outline: none; border-color: var(--accent, #007acc); }
code-editor .cef-toggle, code-editor .cef-btn {
  height: 22px;
  min-width: 22px;
  padding: 0 5px;
  border-radius: 3px;
  color: var(--fg, #c5c5c5);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
}
code-editor .cef-toggle:hover, code-editor .cef-btn:hover { background: #ffffff18; }
code-editor .cef-toggle.active { background: #007acc; color: #fff; }
code-editor .cef-wide { min-width: auto; padding: 0 8px; }
code-editor .cef-count { min-width: 42px; text-align: center; color: #9a9a9a; }

code-editor .code-editor-autocomplete {
  position: absolute;
  z-index: 10;
  min-width: 12rem;
  max-height: 14rem;
  overflow-y: auto;
  margin-top: 2px;
  padding: 4px 0;
  background: var(--bg-alt, #252526);
  border: 1px solid var(--border-light, #454545);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  font-family: inherit;
  font-size: inherit;
  line-height: 1.5;
}

code-editor .code-editor-ac-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1px 10px;
  white-space: pre;
  color: var(--fg, #d4d4d4);
  cursor: pointer;
}

code-editor .code-editor-ac-kind {
  font-size: 0.85em;
  color: var(--fg-dim, #808080);
  user-select: none;
}

code-editor .code-editor-ac-item:hover {
  background: var(--hover, #2a2d2e);
}

code-editor .code-editor-ac-item.selected {
  background: var(--selected, #04395e);
  color: #ffffff;
}
`;

let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected) return;
  const style = document.createElement("style");
  style.dataset.codeEditor = "";
  style.textContent = CSS;
  document.head.appendChild(style);
  stylesInjected = true;
}

class CodeEditorElement extends HTMLElement {
  static get observedAttributes() {
    return ["value", "language"];
  }

  #api = null;

  connectedCallback() {
    if (this.#api) return;
    ensureStyles();

    const initial = this.hasAttribute("value")
      ? this.getAttribute("value")
      : this.textContent;

    this.replaceChildren();
    if (this.tabIndex < 0) this.tabIndex = 0;

    const content = document.createElement("div");
    content.className = "code-editor-content";
    this.appendChild(content);

    this.#api = createEditor({ root: this, content });

    if (this.hasAttribute("language")) {
      this.#api.setLanguage(this.getAttribute("language"));
    }
    if (initial) {
      this.#api.setContent(initial);
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (!this.#api || newVal === oldVal) return;
    if (name === "value")    this.#api.setContent(newVal ?? "");
    if (name === "language") this.#api.setLanguage(newVal);
  }

  setContent(text)        { this.#api?.setContent(text ?? ""); }
  getContent()            { return this.#api?.getContent() ?? ""; }
  getCursor()             { return this.#api?.getCursor(); }
  getSelectedText()       { return this.#api?.getSelectedText() ?? ""; }
  wordAtCursor()          { return this.#api?.wordAtCursor() ?? ""; }
  setCursor(pos)          { this.#api?.setCursor(pos); }
  getSelection()          { return this.#api?.getSelection() ?? null; }
  setSelection(sel)       { this.#api?.setSelection(sel); }
  setBreakpoints(lines)   { this.#api?.setBreakpoints(lines); }
  setDebugLine(n)         { this.#api?.setDebugLine(n); }
  setSmoothScroll(on)     { this.#api?.setSmoothScroll(on); }
  setLanguage(lang)       { this.#api?.setLanguage(lang); }
  selectAll()             { this.#api?.selectAll(); }
  selectLine()            { this.#api?.selectLine(); }
  undo()                  { this.#api?.undo(); }
  redo()                  { this.#api?.redo(); }
  copy()                  { return this.#api?.copy(); }
  cut()                   { return this.#api?.cut(); }
  paste()                 { return this.#api?.paste(); }
  transformCase(mode)     { this.#api?.transformCase(mode); }
  addCursorBelow()        { this.#api?.addCursorBelow(); }
  addCursorAbove()        { this.#api?.addCursorAbove(); }
  addCaretAt(pos)         { this.#api?.addCaretAt(pos); }
  addNextOccurrence()     { this.#api?.addNextOccurrence(); }
  clearMultiCursor()      { this.#api?.clearMultiCursor(); }
  openFind(replaceMode)   { this.#api?.openFind(replaceMode); }
  on(event, fn)           { this.#api?.on(event, fn); }
  registerSaveHandler(fn) { this.#api?.registerSaveHandler(fn); }

  get value()       { return this.getContent(); }
  set value(text)   { this.setContent(text ?? ""); }
}

if (!customElements.get("code-editor")) {
  customElements.define("code-editor", CodeEditorElement);
}

export { CodeEditorElement };
