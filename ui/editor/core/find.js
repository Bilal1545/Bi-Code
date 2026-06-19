// In-editor Find / Replace widget with regex + case toggles. The widget is an
// absolutely-positioned overlay anchored to the editor's top-right; matches are
// shown by moving the editor selection to the current hit.

export function createFind({ root, state, buffer, history, render }) {
  let open = false;
  let matches = [];
  let index = 0;
  let useRegex = false;
  let caseSensitive = false;

  const box = document.createElement("div");
  box.className = "code-editor-find";
  box.style.display = "none";
  box.innerHTML = `
    <div class="cef-row">
      <input class="cef-input" data-find placeholder="Find" spellcheck="false" />
      <button class="cef-toggle" data-rx title="Use Regular Expression">.*</button>
      <button class="cef-toggle" data-case title="Match Case">Aa</button>
      <span class="cef-count">0</span>
      <button class="cef-btn" data-prev title="Previous (Shift+Enter)">↑</button>
      <button class="cef-btn" data-next title="Next (Enter)">↓</button>
      <button class="cef-btn" data-close title="Close (Esc)">✕</button>
    </div>
    <div class="cef-row">
      <input class="cef-input" data-replace placeholder="Replace" spellcheck="false" />
      <button class="cef-btn cef-wide" data-rep title="Replace">Replace</button>
      <button class="cef-btn cef-wide" data-repall title="Replace All">All</button>
    </div>`;
  root.appendChild(box);

  const findInput = box.querySelector("[data-find]");
  const replaceInput = box.querySelector("[data-replace]");
  const countEl = box.querySelector(".cef-count");
  const rxBtn = box.querySelector("[data-rx]");
  const caseBtn = box.querySelector("[data-case]");

  function compile() {
    const q = findInput.value;
    matches = [];
    if (!q) { countEl.textContent = "0"; return; }
    const text = buffer.getText();
    let re;
    try {
      const pattern = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(pattern, "g" + (caseSensitive ? "" : "i"));
    } catch (e) {
      countEl.textContent = "err";
      return;
    }
    let m;
    let guard = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      matches.push({ start: m.index, end: m.index + m[0].length });
      if (++guard > 10000) break;
    }
    countEl.textContent = matches.length ? `${Math.min(index + 1, matches.length)}/${matches.length}` : "0";
  }

  function showMatch() {
    if (!matches.length) return;
    index = (index + matches.length) % matches.length;
    const m = matches[index];
    state.selection = { anchor: buffer.offsetToPos(m.start), head: buffer.offsetToPos(m.end) };
    state.cursor = buffer.offsetToPos(m.end);
    countEl.textContent = `${index + 1}/${matches.length}`;
    render();
  }

  function next(dir) {
    if (!matches.length) compile();
    if (!matches.length) return;
    index += dir;
    showMatch();
  }

  function replaceCurrent() {
    if (!matches.length) return;
    const m = matches[index];
    history.record("replace");
    state.selection = { anchor: buffer.offsetToPos(m.start), head: buffer.offsetToPos(m.end) };
    buffer.insertText(replaceInput.value);
    render();
    compile();
    if (matches.length) { index = Math.min(index, matches.length - 1); showMatch(); }
  }

  function replaceAll() {
    compile();
    if (!matches.length) return;
    history.record("replace");
    // Replace from the last match backwards so earlier offsets stay valid.
    const rep = replaceInput.value;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      state.selection = { anchor: buffer.offsetToPos(m.start), head: buffer.offsetToPos(m.end) };
      buffer.insertText(rep);
    }
    state.selection = null;
    render();
    const n = matches.length;
    compile();
    countEl.textContent = `0 (replaced ${n})`;
  }

  box.querySelector("[data-next]").onclick = () => next(1);
  box.querySelector("[data-prev]").onclick = () => next(-1);
  box.querySelector("[data-close]").onclick = () => close();
  box.querySelector("[data-rep]").onclick = replaceCurrent;
  box.querySelector("[data-repall]").onclick = replaceAll;
  rxBtn.onclick = () => { useRegex = !useRegex; rxBtn.classList.toggle("active", useRegex); compile(); };
  caseBtn.onclick = () => { caseSensitive = !caseSensitive; caseBtn.classList.toggle("active", caseSensitive); compile(); };

  findInput.addEventListener("input", () => { index = 0; compile(); });
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); next(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  replaceInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); replaceCurrent(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  });

  function openWidget(replaceMode) {
    open = true;
    box.style.display = "block";
    box.classList.toggle("with-replace", !!replaceMode);
    // seed with current selection
    const sel = buffer.getSelectedText();
    if (sel && !sel.includes("\n")) findInput.value = sel;
    index = 0;
    compile();
    findInput.focus();
    findInput.select();
  }
  function close() {
    open = false;
    box.style.display = "none";
    root.focus();
  }

  return {
    open: (replaceMode) => openWidget(replaceMode),
    close,
    isOpen: () => open,
  };
}
