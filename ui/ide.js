import "./editor/code-editor.js";
import { detectLanguage } from "./editor/syntax/languages.js";
import { fileIconSvg, folderIconSvg, setSetiTheme, SETI_THEME_URL } from "./icons.js";

// ---------------------------------------------------------------------------
// Tauri bridges (withGlobalTauri = true)
// ---------------------------------------------------------------------------
const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const openDialog = TAURI.dialog.open;
const appWindow = TAURI.window.getCurrentWindow();

const sep = "/";
const dirname = (p) => p.slice(0, p.lastIndexOf(sep)) || sep;
const basename = (p) => p.slice(p.lastIndexOf(sep) + 1);
const join = (dir, name) => (dir.endsWith(sep) ? dir + name : dir + sep + name);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  root: null,
  expanded: new Set(),
  treeCache: new Map(), // dir path -> entries[]
  selected: null,       // currently highlighted tree path
  tabs: new Map(),      // path -> { path, name, content, saved, dirty, cursor, lang }
  active: null,         // active tab path
  ssh: null,            // active SSH connection id (null = local filesystem)
};

// Filesystem layer — routes file operations to the local FS or, when an SSH
// connection is active, to the remote host over SFTP.
const fsList = (path) => (state.ssh ? invoke("ssh_list_dir", { id: state.ssh, path }) : invoke("list_dir", { path }));
const fsRead = (path) => (state.ssh ? invoke("ssh_read_file", { id: state.ssh, path }) : invoke("read_file", { path }));
const fsReadBase64 = (path) => (state.ssh ? invoke("ssh_read_file_base64", { id: state.ssh, path }) : invoke("read_file_base64", { path }));
const fsWrite = (path, contents) => (state.ssh ? invoke("ssh_write_file", { id: state.ssh, path, contents }) : invoke("write_file", { path, contents }));
const fsCreateFile = (path) => (state.ssh ? invoke("ssh_create_file", { id: state.ssh, path }) : invoke("create_file", { path }));
const fsCreateDir = (path) => (state.ssh ? invoke("ssh_create_dir", { id: state.ssh, path }) : invoke("create_dir", { path }));
const fsRename = (from, to) => (state.ssh ? invoke("ssh_rename", { id: state.ssh, from, to }) : invoke("rename_path", { from, to }));
const fsDelete = (path) => (state.ssh ? invoke("ssh_delete", { id: state.ssh, path }) : invoke("delete_path", { path }));

let editor = null;       // the <code-editor> element
let suppressChange = false;
let restoring = false;   // true while replaying a saved session (suppresses re-save)

// ---------------------------------------------------------------------------
// Session persistence — the open folder, expanded tree, tabs and per-tab
// cursor are stored in localStorage (which the webview persists across
// restarts) so the editor reopens exactly where it was left.
// ---------------------------------------------------------------------------
const SESSION_KEY = "editor-ide:session:v1";
let sessionTimer = null;

function saveSession() {
  if (restoring) return;
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(persistSession, 400);
}

function persistSession() {
  clearTimeout(sessionTimer);
  if (state.ssh) return; // don't persist remote sessions
  if (!state.root) {
    localStorage.removeItem(SESSION_KEY);
    return;
  }
  // Fold the active tab's live cursor + selection back in before serializing.
  if (state.active && editor) {
    const at = state.tabs.get(state.active);
    if (at && (!at.kind || (at.kind === "image" && at.isSvg && at.mode === "code"))) {
      at.cursor = editor.getCursor();
      at.selection = editor.getSelection();
    }
  }
  const data = {
    root: state.root,
    expanded: [...state.expanded],
    active: state.active,
    view: document.querySelector(".act-btn.active")?.dataset.view || "explorer",
    termOpen: !$("terminal-panel").hidden,
    terms: [...terminals.values()].map((t) => ({ title: t.title, location: t.location, out: (t.outBuf || "").slice(-TERM_SAVE_CHARS) })),
    tabs: [...state.tabs.values()]
      .filter((t) => t.kind !== "preview" && t.kind !== "extension" && t.kind !== "terminal")
      .map((t) => ({ path: t.path, cursor: t.cursor, selection: t.selection || null })),
  };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch (e) {
    /* storage full / disabled — non-fatal */
  }
}

async function restoreSession() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch (e) {
    data = null;
  }
  if (!data || !data.root) return false;

  restoring = true;
  try {
    await setRoot(data.root);
    // Re-expand directories the user had open, loading children as needed.
    for (const dir of data.expanded || []) {
      if (dir === data.root) continue;
      state.expanded.add(dir);
      if (!state.treeCache.has(dir)) await loadDir(dir);
    }
    renderTree();

    // Reopen tabs without activating each (avoids flicker); missing files are
    // skipped silently since the folder may have changed while we were closed.
    for (const t of data.tabs || []) {
      await openFile(t.path, { silent: true, defer: true, cursor: t.cursor });
      const tb = state.tabs.get(t.path);
      if (tb && t.selection) tb.selection = t.selection;
    }

    // Reopen terminals (fresh shells); re-dock the ones that were in the editor.
    for (const ti of (data.terms || []).slice(0, 8)) {
      await newTerminal({ initial: ti.out || "" });
      const id = activeTermId;
      if (id && ti.title) setTermTitle(id, ti.title);
      if (id && ti.location === "editor") moveTerminalToEditor(id);
    }
    if (!data.termOpen) hideTerminalPanel();

    // Restore which activity-bar view was open.
    if (data.view && data.view !== "explorer") {
      const b = document.querySelector(`.act-btn[data-view="${data.view}"]`);
      if (b) b.click();
    }

    const active = state.tabs.has(data.active)
      ? data.active
      : [...state.tabs.keys()].find((k) => !/^(ext|preview|term):\/\//.test(k));
    if (active) activateTab(active);
  } catch (e) {
    restoring = false;
    return false;
  }
  restoring = false;
  return !!state.root;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const treeEl = $("tree");
const tabbarEl = $("tabbar");
const editorHost = $("editor-host");
const welcomeEl = $("welcome");
const openPrompt = $("open-folder-prompt");
const ctxMenu = $("context-menu");
const dropdown = $("dropdown");

// ===========================================================================
// File-type icons (lightweight, text/emoji based)
// ===========================================================================
const FILE_ICONS = {
  js: "🟨", mjs: "🟨", cjs: "🟨", jsx: "🟨", ts: "🟦", tsx: "🟦",
  py: "🐍", rs: "🦀", go: "🐹", json: "🔧",
  html: "🌐", htm: "🌐", css: "🎨", scss: "🎨",
  md: "📝", txt: "📄", toml: "⚙️", yml: "⚙️", yaml: "⚙️",
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️",
  lock: "🔒", gitignore: "🌿",
};
function fileIcon(name) {
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  return FILE_ICONS[ext] || "📄";
}

// ===========================================================================
// Toast notifications
// ===========================================================================
let toastTimer = null;
function toast(message, isError = false) {
  let el = $("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ===========================================================================
// Folder opening + tree
// ===========================================================================
async function openFolder() {
  const picked = await openDialog({ directory: true, multiple: false });
  if (!picked) return;
  await setRoot(picked);
}

async function setRoot(path) {
  state.root = path;
  addRecent(path);
  state.expanded = new Set([path]);
  state.treeCache.clear();
  $("sidebar-title").textContent = basename(path).toUpperCase() || "EXPLORER";
  openPrompt.hidden = true;
  treeEl.hidden = false;
  await loadDir(path);
  renderTree();
  saveSession();
  gitMaybeRefresh();
  updateLiveStatus();
  updateCommandCenter();
  if (!$("tasks-view").hidden) renderTasksSidebar();
}

function updateCommandCenter() {
  const el = $("cc-label");
  if (el) el.textContent = state.root ? basename(state.root) : "Bi-Code";
}

async function loadDir(path) {
  try {
    const entries = (await fsList(path)).filter((e) => e.name !== ".git");
    state.treeCache.set(path, entries);
    return entries;
  } catch (e) {
    toast("Could not read folder: " + e, true);
    state.treeCache.set(path, []);
    return [];
  }
}

// Expand/collapse with targeted DOM updates so the chevron can transition
// smoothly (a full renderTree() recreates the element and would skip the
// animation). Other callers still use renderTree() for a full rebuild.
function toggleDir(path) {
  const row = treeEl.querySelector(`.tree-item[data-path="${cssEsc(path)}"]`);

  if (state.expanded.has(path)) {
    state.expanded.delete(path);
    if (row) {
      row.querySelector(".tree-chevron")?.classList.remove("open");
      const depth = +row.dataset.depth;
      let n = row.nextElementSibling;
      while (n && +n.dataset.depth > depth) { const next = n.nextElementSibling; n.remove(); n = next; }
    }
    highlightActiveGuide();
    saveSession();
    return;
  }

  state.expanded.add(path);
  const ready = state.treeCache.has(path) ? Promise.resolve() : loadDir(path);
  ready.then(() => {
    const r = treeEl.querySelector(`.tree-item[data-path="${cssEsc(path)}"]`);
    if (!r) { renderTree(); saveSession(); return; }
    r.querySelector(".tree-chevron")?.classList.add("open");
    const depth = +r.dataset.depth;
    const frag = document.createDocumentFragment();
    renderEntries(state.treeCache.get(path) || [], frag, depth + 1);
    r.after(frag);
    highlightActiveGuide();
    saveSession();
  });
}

function renderTree() {
  treeEl.innerHTML = "";
  if (!state.root) return;
  const rootEntries = state.treeCache.get(state.root) || [];
  renderEntries(rootEntries, treeEl, 1);
  highlightActiveGuide();
}

// Make the indent guide that connects the selected item to its parent more
// prominent — highlighted across the whole sibling block (VSCode-style).
function highlightActiveGuide() {
  treeEl.querySelectorAll(".tree-indent.active-guide").forEach((g) => g.classList.remove("active-guide"));
  const sel = treeEl.querySelector(".tree-item.selected");
  if (!sel) return;
  const selDepth = +sel.dataset.depth;
  if (selDepth < 2) return; // top-level items have no parent guide
  const col = selDepth - 2; // innermost guide span index
  const rows = [...treeEl.querySelectorAll(".tree-item")];
  const idx = rows.indexOf(sel);
  const mark = (r) => { const g = r.querySelectorAll(".tree-indent")[col]; if (g) g.classList.add("active-guide"); };
  mark(sel);
  for (let i = idx - 1; i >= 0 && +rows[i].dataset.depth >= selDepth; i--) mark(rows[i]);
  for (let i = idx + 1; i < rows.length && +rows[i].dataset.depth >= selDepth; i++) mark(rows[i]);
}

function renderEntries(entries, container, depth) {
  for (const entry of entries) {
    const row = makeTreeRow(entry, depth);
    container.appendChild(row);
    if (entry.is_dir && state.expanded.has(entry.path)) {
      const children = state.treeCache.get(entry.path) || [];
      renderEntries(children, container, depth + 1);
    }
  }
}

function makeTreeRow(entry, depth) {
  const row = document.createElement("div");
  row.className = "tree-item";
  row.dataset.path = entry.path;
  row.dataset.isDir = entry.is_dir ? "1" : "0";
  row.dataset.depth = depth;
  row.style.paddingLeft = depth * 12 + 4 + "px";
  if (state.selected === entry.path) row.classList.add("selected");

  // indent guides: absolutely-positioned vertical lines (don't take layout
  // space, just sit to the left of the icons) — one per ancestor level.
  for (let i = 1; i < depth; i++) {
    const g = document.createElement("span");
    g.className = "tree-indent";
    g.style.left = i * 12 + 12 + "px";
    row.appendChild(g);
  }

  const twisty = document.createElement("span");
  twisty.className = "tree-twisty";
  // Folders show a rotating chevron (VSCode-style) instead of a folder icon.
  if (entry.is_dir) {
    twisty.innerHTML = `<svg class="tree-chevron${state.expanded.has(entry.path) ? " open" : ""}" viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = entry.name;

  if (entry.is_dir) {
    row.append(twisty, label);
  } else {
    // no chevron column for files — the icon sits where a folder's chevron is,
    // so files line up with folders at the same depth.
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.innerHTML = fileIconSvg(entry.name);
    row.append(icon, label);
  }

  // Git decorations: changed/untracked files turn green with a "U" badge;
  // folders that contain such files get a green dot.
  if (isGitIgnored(entry.path)) {
    row.classList.add("git-ignored");
  } else if (entry.is_dir) {
    if (state.gitDirs && state.gitDirs.has(entry.path)) {
      row.classList.add("git-dir-changed");
      const dot = document.createElement("span");
      dot.className = "tree-git-dot";
      row.appendChild(dot);
    }
  } else if (state.gitChanged && state.gitChanged.has(entry.path)) {
    row.classList.add("git-changed");
    const badge = document.createElement("span");
    badge.className = "tree-git-badge";
    badge.textContent = "U";
    row.appendChild(badge);
  }

  row.addEventListener("click", () => {
    state.selected = entry.path;
    if (entry.is_dir) toggleDir(entry.path);
    else { renderTree(); openFile(entry.path); }
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    state.selected = entry.path;
    renderTree();
    showTreeContextMenu(e, entry);
  });
  return row;
}

// ===========================================================================
// Editor / tabs
// ===========================================================================
function ensureEditor() {
  if (editor) return editor;
  editor = document.createElement("code-editor");
  editorHost.appendChild(editor);

  editor.on("change", (text) => {
    if (suppressChange || !state.active) return;
    const tab = state.tabs.get(state.active);
    if (!tab) return;
    tab.content = text;
    tab.dirty = text !== tab.saved;
    updateTab(tab);
  });
  editor.on("cursorChange", (cur) => {
    $("status-cursor").textContent = `Ln ${cur.line + 1}, Col ${cur.col + 1}`;
    saveSession();
  });
  editor.registerSaveHandler(() => saveActive());
  editor.on("breakpoint", (line) => {
    const tab = state.active && state.tabs.get(state.active);
    if (tab && !tab.kind) toggleBreakpoint(state.active, line);
  });
  editor.setSmoothScroll(settings.smoothScroll);
  return editor;
}

async function openFile(path, opts = {}) {
  if (state.tabs.has(path)) {
    if (!opts.defer) activateTab(path);
    return;
  }
  // Images open in a viewer; SVGs preview with a toggle to the code.
  if (isImagePath(path)) {
    return openImage(path, opts);
  }
  // SQLite files open as an editable table view instead of as text.
  if (settings.sqlEnabled && !state.ssh && isDbPath(path)) {
    return openDb(path, opts);
  }
  let content;
  try {
    content = await fsRead(path);
  } catch (e) {
    if (!opts.silent) toast("Cannot open file (binary or unreadable): " + basename(path), true);
    return;
  }
  const tab = {
    path,
    name: basename(path),
    content,
    saved: content,
    dirty: false,
    cursor: opts.cursor || { line: 0, col: 0 },
    lang: detectLanguage(path),
  };
  state.tabs.set(path, tab);
  renderTabs();
  if (!opts.defer) activateTab(path);
  saveSession();
}

function activateTab(path) {
  // stash current text tab's live content before switching
  if (state.active && state.active !== path) {
    const prev = state.tabs.get(state.active);
    if (prev && !prev.kind && editor) {
      prev.content = editor.getContent();
      prev.cursor = editor.getCursor();
      prev.selection = editor.getSelection();
    } else if (prev && prev.kind === "image" && prev.isSvg && prev.mode === "code" && editor) {
      prev.content = editor.getContent();
    }
  }
  state.active = path;
  const tab = state.tabs.get(path);
  if (!tab) return;

  welcomeEl.style.display = "none";

  if (tab.kind === "db") {
    if (editor) editor.style.display = "none";
    hidePreview();
    hideExtensionView();
    hideTerminalView();
    hideImageView();
    showDbView(tab);
  } else if (tab.kind === "preview") {
    if (editor) editor.style.display = "none";
    hideDbView();
    hideExtensionView();
    hideTerminalView();
    hideImageView();
    showPreview(tab);
  } else if (tab.kind === "extension") {
    if (editor) editor.style.display = "none";
    hideDbView();
    hidePreview();
    hideTerminalView();
    hideImageView();
    renderExtensionPage(tab);
  } else if (tab.kind === "terminal") {
    if (editor) editor.style.display = "none";
    hideDbView();
    hidePreview();
    hideExtensionView();
    hideImageView();
    showTerminalView(tab);
  } else if (tab.kind === "image" && !(tab.isSvg && tab.mode === "code")) {
    // image / svg preview
    showImageView(tab);
  } else {
    hideDbView();
    hidePreview();
    hideExtensionView();
    hideTerminalView();
    hideImageView();
    ensureEditor();
    editor.style.display = "block";
    suppressChange = true;
    editor.setLanguage(tab.lang || "");
    editor.setContent(tab.content);
    if (tab.cursor) editor.setCursor(tab.cursor);
    if (tab.selection) editor.setSelection(tab.selection);
    suppressChange = false;
    editor.setDebugLine(null);
    editor.setBreakpoints([...(breakpoints.get(tab.path) || [])]);
    editor.focus();
  }

  renderTabs();
  updateStatus(tab);
  showSvgToggle(tab);
  updateBreadcrumb(tab);
  saveSession();
}

function closeTab(path) {
  const tab = state.tabs.get(path);
  if (!tab) return;
  if (tab.dirty && !confirm(`Discard unsaved changes to ${tab.name}?`)) return;
  // closing a docked terminal tab returns it to the bottom panel (keeps running)
  if (tab.kind === "terminal") moveTerminalToPanel(tab.termId);

  const order = [...state.tabs.keys()];
  const idx = order.indexOf(path);
  state.tabs.delete(path);

  if (state.active === path) {
    const remaining = [...state.tabs.keys()];
    const next = remaining[Math.min(idx, remaining.length - 1)];
    state.active = null;
    if (next) activateTab(next);
    else showWelcome();
  }
  renderTabs();
  saveSession();
}

function showWelcome() {
  state.active = null;
  if (editor) editor.style.display = "none";
  hideDbView();
  hidePreview();
  hideExtensionView();
  hideTerminalView();
  hideImageView();
  $("breadcrumb").hidden = true;
  welcomeEl.style.display = "flex";
  $("status-path").textContent = "";
  $("status-lang").textContent = "";
  $("status-cursor").textContent = "Ln 1, Col 1";
}

function renderTabs() {
  tabbarEl.innerHTML = "";
  for (const tab of state.tabs.values()) {
    const el = document.createElement("div");
    el.className = "tab" + (tab.path === state.active ? " active" : "") + (tab.dirty ? " dirty" : "");
    el.dataset.path = tab.path;
    el.title = tab.path;

    const icon = document.createElement("span");
    icon.className = "tab-ic";
    icon.innerHTML = fileIconSvg(tab.name);
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.name;
    const dot = document.createElement("span");
    dot.className = "dirty-dot";
    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "✕";

    el.append(icon, label, dot, close);
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.path); }   // middle click
    });
    el.addEventListener("click", (e) => {
      if (e.target === close) closeTab(tab.path);
      else activateTab(tab.path);
    });
    // drag to reorder
    el.draggable = true;
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", tab.path); e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
    el.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
    el.addEventListener("drop", (e) => { e.preventDefault(); const from = e.dataTransfer.getData("text/plain"); if (from && from !== tab.path) reorderTabs(from, tab.path); });
    tabbarEl.appendChild(el);
  }
}

function reorderTabs(from, to) {
  if (!state.tabs.has(from) || !state.tabs.has(to)) return;
  const entries = [...state.tabs.entries()];
  const moved = entries.find(([k]) => k === from);
  const rest = entries.filter(([k]) => k !== from);
  const idx = rest.findIndex(([k]) => k === to);
  rest.splice(idx, 0, moved);
  state.tabs = new Map(rest);
  renderTabs();
  saveSession();
}

function updateTab(tab) {
  const el = tabbarEl.querySelector(`.tab[data-path="${cssEsc(tab.path)}"]`);
  if (el) el.classList.toggle("dirty", tab.dirty);
}

function updateStatus(tab) {
  if (tab.kind === "terminal") {
    $("status-path").textContent = tab.name;
    $("status-lang").textContent = "Terminal";
    $("status-cursor").textContent = "";
  } else if (tab.kind === "extension") {
    $("status-path").textContent = tab.ext ? `${tab.ext.namespace}.${tab.ext.name}` : tab.name;
    $("status-lang").textContent = "Extension";
    $("status-cursor").textContent = "";
  } else if (tab.kind === "preview") {
    $("status-path").textContent = tab.url;
    $("status-lang").textContent = "Preview";
    $("status-cursor").textContent = "";
  } else if (tab.kind === "db") {
    $("status-path").textContent = tab.path;
    $("status-lang").textContent = "SQLite";
    $("status-cursor").textContent = "";
  } else if (tab.kind === "image") {
    $("status-path").textContent = tab.path;
    $("status-lang").textContent = tab.isSvg ? (tab.mode === "code" ? "SVG (code)" : "SVG") : "Image";
    $("status-cursor").textContent = "";
  } else {
    $("status-path").textContent = tab.path;
    $("status-lang").textContent = tab.lang || "plain text";
  }
  document.title = (tab.dirty ? "● " : "") + tab.name + " — Bi-Code";
}

async function saveActive() {
  if (!state.active) return;
  const tab = state.tabs.get(state.active);
  if (!tab) return;
  // only text editors (and SVG in code mode) are saveable
  const editable = !tab.kind || (tab.kind === "image" && tab.isSvg && tab.mode === "code");
  if (!editable) return;
  tab.content = editor.getContent();
  try {
    await fsWrite(tab.path, tab.content);
    tab.saved = tab.content;
    tab.dirty = false;
    updateTab(tab);
    updateStatus(tab);
    toast("Saved " + tab.name);
    gitMaybeRefresh();
  } catch (e) {
    toast("Save failed: " + e, true);
  }
}

const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&"));

// ===========================================================================
// File operations (new / rename / delete)
// ===========================================================================
function targetDirFor(path) {
  if (!path) return state.root;
  if (state.treeCache.has(path)) return path;          // it's a known dir
  const entry = findEntry(path);
  return entry && entry.is_dir ? path : dirname(path);
}

function findEntry(path) {
  for (const entries of state.treeCache.values()) {
    const hit = entries.find((e) => e.path === path);
    if (hit) return hit;
  }
  return null;
}

async function newFile(dir) {
  const name = await promptName("New File", "");
  if (!name) return;
  const path = join(dir, name);
  try {
    await fsCreateFile(path);
    await refreshDir(dir);
    state.expanded.add(dir);
    renderTree();
    openFile(path);
  } catch (e) { toast("Create failed: " + e, true); }
}

async function newFolder(dir) {
  const name = await promptName("New Folder", "");
  if (!name) return;
  const path = join(dir, name);
  try {
    await fsCreateDir(path);
    await refreshDir(dir);
    state.expanded.add(dir);
    renderTree();
  } catch (e) { toast("Create failed: " + e, true); }
}

async function renameEntry(entry) {
  const name = await promptName("Rename", entry.name);
  if (!name || name === entry.name) return;
  const to = join(dirname(entry.path), name);
  try {
    await fsRename(entry.path, to);
    // update any open tab
    if (state.tabs.has(entry.path)) {
      const tab = state.tabs.get(entry.path);
      state.tabs.delete(entry.path);
      tab.path = to; tab.name = name; tab.lang = detectLanguage(to);
      state.tabs.set(to, tab);
      if (state.active === entry.path) state.active = to;
      renderTabs();
    }
    await refreshDir(dirname(entry.path));
    renderTree();
    saveSession();
  } catch (e) { toast("Rename failed: " + e, true); }
}

async function deleteEntry(entry) {
  if (!confirm(`Delete ${entry.name}? This cannot be undone.`)) return;
  try {
    await fsDelete(entry.path);
    if (state.tabs.has(entry.path)) {
      state.tabs.delete(entry.path);
      if (state.active === entry.path) {
        const next = [...state.tabs.keys()][0];
        state.active = null;
        next ? activateTab(next) : showWelcome();
      }
      renderTabs();
    }
    await refreshDir(dirname(entry.path));
    renderTree();
    saveSession();
  } catch (e) { toast("Delete failed: " + e, true); }
}

async function refreshDir(dir) {
  state.treeCache.delete(dir);
  await loadDir(dir);
}

// ===========================================================================
// Inline name prompt (small modal)
// ===========================================================================
function promptName(title, initial) {
  return new Promise((resolve) => {
    const value = window.prompt(title, initial);
    resolve(value ? value.trim() : null);
  });
}

// ===========================================================================
// Context menu (file tree)
// ===========================================================================
function showTreeContextMenu(e, entry) {
  const dir = entry.is_dir ? entry.path : dirname(entry.path);
  const items = [
    { label: "New File", action: () => newFile(dir) },
    { label: "New Folder", action: () => newFolder(dir) },
    { sep: true },
    { label: "Rename", action: () => renameEntry(entry) },
    { label: "Delete", action: () => deleteEntry(entry) },
  ];
  if (entry.is_dir) {
    items.unshift({ label: "Refresh", action: async () => { await refreshDir(entry.path); renderTree(); } });
    items.unshift({ sep: true });
  }
  popupMenu(ctxMenu, e.clientX, e.clientY, items);
}

function popupMenu(el, x, y, items) {
  el.innerHTML = "";
  for (const item of items) {
    if (item.sep) {
      const s = document.createElement("div");
      s.className = "menu-sep";
      el.appendChild(s);
      continue;
    }
    const mi = document.createElement("div");
    mi.className = "menu-item";
    const label = document.createElement("span");
    label.textContent = item.label;
    mi.appendChild(label);
    if (item.shortcut) {
      const sc = document.createElement("span");
      sc.className = "shortcut";
      sc.textContent = item.shortcut;
      mi.appendChild(sc);
    }
    mi.addEventListener("click", () => { hideMenus(); item.action(); });
    el.appendChild(mi);
  }
  el.hidden = false;
  // keep on screen
  const rect = el.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 4);
  const py = Math.min(y, window.innerHeight - rect.height - 4);
  el.style.left = px + "px";
  el.style.top = py + "px";
}

function hideMenus() {
  ctxMenu.hidden = true;
  dropdown.hidden = true;
}

// ===========================================================================
// File menu (titlebar dropdown)
// ===========================================================================
function showFileMenu(btn) {
  const rect = btn.getBoundingClientRect();
  popupMenu(dropdown, rect.left, rect.bottom, [
    { label: "New Window", action: newWindow },
    { sep: true },
    { label: "Open Folder…", shortcut: "Ctrl+K", action: openFolder },
    { label: "Open Recent", action: () => showRecentMenu(btn) },
    { label: "Open SSH Folder…", action: openSshModal },
    { label: "Clone Repository…", action: cloneRepo },
    ...(state.ssh ? [{ label: "Close Remote Connection", action: sshDisconnect }] : []),
    { label: "New File", shortcut: "Ctrl+N", action: () => newFile(targetDirFor(state.selected) || state.root) },
    { sep: true },
    { label: "Save", shortcut: "Ctrl+S", action: saveActive },
    { sep: true },
    { label: "Close Tab", shortcut: "Ctrl+W", action: () => state.active && closeTab(state.active) },
  ]);
}

// ----- clone repository / new window -----
async function cloneRepo() {
  const url = window.prompt("Repository URL to clone:", "https://github.com/");
  if (!url || !url.trim()) return;
  const dest = await openDialog({ directory: true, multiple: false });
  if (!dest) return;
  toast("Cloning…");
  try {
    const path = await invoke("git_clone", { url: url.trim(), dest });
    await setRoot(path);
    toast("Cloned into " + basename(path));
  } catch (e) {
    toast("Clone failed: " + e, true);
  }
}
function newWindow() {
  invoke("new_window").catch((e) => toast("Could not open window: " + e, true));
}

// ----- SSH remote folders -----
function openSshModal() {
  $("ssh-overlay").hidden = false;
  setTimeout(() => $("ssh-host").focus(), 0);
}
function closeSshModal() { $("ssh-overlay").hidden = true; }

async function sshConnect() {
  const host = $("ssh-host").value.trim();
  if (!host) { toast("Host is required", true); return; }
  const port = parseInt($("ssh-port").value, 10) || 22;
  const user = $("ssh-user").value.trim() || "root";
  const password = $("ssh-pass").value;
  const keyPath = $("ssh-key").value.trim();
  let path = $("ssh-path").value.trim();
  const btn = $("ssh-connect-btn");
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    const id = await invoke("ssh_connect", { host, port, user, password: password || null, keyPath: keyPath || null });
    state.ssh = id;
    if (!path) { try { path = await invoke("ssh_home", { id }); } catch (e) { path = "/"; } }
    // start fresh: drop any locally-open tabs
    state.tabs.clear(); state.active = null; renderTabs(); showWelcome();
    closeSshModal();
    await setRoot(path);
    toast("Connected: " + id);
  } catch (e) {
    state.ssh = null;
    toast("SSH connect failed: " + e, true);
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
}

async function sshDisconnect() {
  if (!state.ssh) return;
  const id = state.ssh;
  state.ssh = null;
  state.root = null;
  state.tabs.clear(); state.active = null;
  state.treeCache.clear(); state.expanded = new Set();
  renderTabs(); renderTree(); showWelcome();
  $("sidebar-title").textContent = "EXPLORER";
  openPrompt.hidden = false; treeEl.hidden = true;
  updateCommandCenter(); updateLiveStatus(); updateBranchStatus(null);
  try { await invoke("ssh_disconnect", { id }); } catch (e) { /* ignore */ }
  toast("Disconnected from " + id);
}

// ----- Recent workspaces -----
const RECENT_KEY = "editor-ide:recent:v1";
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch (e) { return []; }
}
function addRecent(path) {
  if (!path || state.ssh) return; // remote folders aren't auto-reopenable
  const list = loadRecent().filter((r) => r.path !== path);
  list.unshift({ path, name: basename(path) || path });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 15))); } catch (e) { /* ignore */ }
}

function showRecentMenu(btn) {
  const rect = btn.getBoundingClientRect();
  const recents = loadRecent();
  if (!recents.length) {
    popupMenu(dropdown, rect.left, rect.bottom, [{ label: "No recent folders", action: () => {} }]);
    return;
  }
  const items = recents.map((r) => ({
    label: r.name,
    shortcut: r.path.length > 42 ? "…" + r.path.slice(-40) : r.path,
    action: () => setRoot(r.path),
  }));
  items.push({ sep: true });
  items.push({
    label: "Clear Recent",
    action: () => { localStorage.removeItem(RECENT_KEY); },
  });
  popupMenu(dropdown, rect.left, rect.bottom, items);
}

// ----- Edit / Selection / View / Help menus -----
function activeTextEditor() {
  const tab = state.active && state.tabs.get(state.active);
  if (!editor || !tab || tab.kind) return null;
  return editor;
}
function editorAction(fn) {
  const ed = activeTextEditor();
  if (!ed) { toast("Open a file to use this action."); return; }
  fn(ed);
  ed.focus();
}

function showEditMenu(btn) {
  const r = btn.getBoundingClientRect();
  popupMenu(dropdown, r.left, r.bottom, [
    { label: "Undo", shortcut: "Ctrl+Z", action: () => editorAction((e) => e.undo()) },
    { label: "Redo", shortcut: "Ctrl+Y", action: () => editorAction((e) => e.redo()) },
    { sep: true },
    { label: "Cut", shortcut: "Ctrl+X", action: () => editorAction((e) => e.cut()) },
    { label: "Copy", shortcut: "Ctrl+C", action: () => editorAction((e) => e.copy()) },
    { label: "Paste", shortcut: "Ctrl+V", action: () => editorAction((e) => e.paste()) },
    { sep: true },
    { label: "Find / Replace", shortcut: "Ctrl+F", action: () => editorAction((e) => e.openFind()) },
    { label: "Find in Files", shortcut: "Ctrl+Shift+F", action: () => clickActAndFocus("search") },
    { sep: true },
    { label: "Select All", shortcut: "Ctrl+A", action: () => editorAction((e) => e.selectAll()) },
  ]);
}

function showSelectionMenu(btn) {
  const r = btn.getBoundingClientRect();
  popupMenu(dropdown, r.left, r.bottom, [
    { label: "Select All", shortcut: "Ctrl+A", action: () => editorAction((e) => e.selectAll()) },
    { label: "Select Current Line", shortcut: "Ctrl+L", action: () => editorAction((e) => e.selectLine()) },
    { sep: true },
    { label: "Add Cursor Below", shortcut: "Ctrl+Alt+↓", action: () => editorAction((e) => e.addCursorBelow()) },
    { label: "Add Cursor Above", shortcut: "Ctrl+Alt+↑", action: () => editorAction((e) => e.addCursorAbove()) },
    { label: "Add Next Occurrence", shortcut: "Ctrl+D", action: () => editorAction((e) => e.addNextOccurrence()) },
    { label: "Clear Extra Cursors", shortcut: "Esc", action: () => editorAction((e) => e.clearMultiCursor()) },
    { sep: true },
    { label: "UPPERCASE", shortcut: "Ctrl+Shift+U", action: () => editorAction((e) => e.transformCase("upper")) },
    { label: "lowercase", shortcut: "Ctrl+Shift+L", action: () => editorAction((e) => e.transformCase("lower")) },
    { label: "Title Case", action: () => editorAction((e) => e.transformCase("title")) },
  ]);
}

function showViewMenu(btn) {
  const r = btn.getBoundingClientRect();
  popupMenu(dropdown, r.left, r.bottom, [
    { label: "Command Palette…", shortcut: settings.commandPaletteKey, action: openPalette },
    { sep: true },
    { label: "Explorer", action: () => clickActAndFocus("explorer") },
    { label: "Search", shortcut: "Ctrl+Shift+F", action: () => clickActAndFocus("search") },
    { label: "Source Control", action: () => clickActAndFocus("scm") },
    { label: "Commands", action: () => clickActAndFocus("tasks") },
    { label: "Themes", action: () => clickActAndFocus("extensions") },
    { sep: true },
    { label: "Toggle Terminal", shortcut: "Ctrl+`", action: toggleTerminal },
    { label: "Toggle Live Server", action: toggleLiveServer },
    { sep: true },
    { label: "Color Theme…", action: openThemeQuickPick },
    { label: "Settings", action: openSettings },
  ]);
}

function showHelpMenu(btn) {
  const r = btn.getBoundingClientRect();
  popupMenu(dropdown, r.left, r.bottom, [
    { label: "Welcome / Get Started", action: () => showWelcomeScreen(true) },
    { label: "Command Palette (all commands)…", shortcut: settings.commandPaletteKey, action: openPalette },
    { label: "About Bi-Code", action: () => toast("Bi-Code — tree-sitter powered editor in a Tauri shell.") },
  ]);
}

// ----- editor context menu + MDN lookup -----
function mdnUrl(term, lang) {
  const t = (term || "").trim();
  if (!t) return "https://developer.mozilla.org/en-US/";
  if (lang === "css") return "https://developer.mozilla.org/en-US/docs/Web/CSS/" + encodeURIComponent(t);
  return "https://developer.mozilla.org/en-US/search?q=" + encodeURIComponent(t);
}

// Open in the system browser (Tauri webview ignores window.open for http URLs).
async function openExternal(url) {
  try { await invoke("open_url", { url }); }
  catch (e) { try { window.open(url, "_blank"); } catch (e2) { toast("Could not open: " + url, true); } }
}

// MDN blocks being framed (X-Frame-Options), so fetch the page server-side and
// show it via srcdoc with scripts stripped (keeps the rendered article + CSS).
async function fetchMdnDoc(url) {
  let html = await invoke("http_get_text", { url });
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${url}">`);
  return html;
}

function showEditorContextMenu(e) {
  const ed = activeTextEditor();
  if (!ed) return;
  e.preventDefault();
  const term = (ed.getSelectedText() || ed.wordAtCursor() || "").trim();
  const lang = state.active && state.tabs.get(state.active)?.lang;
  const items = [
    { label: "Cut", shortcut: "Ctrl+X", action: () => ed.cut() },
    { label: "Copy", shortcut: "Ctrl+C", action: () => ed.copy() },
    { label: "Paste", shortcut: "Ctrl+V", action: () => ed.paste() },
    { sep: true },
    { label: "Select All", shortcut: "Ctrl+A", action: () => ed.selectAll() },
    { label: "Find / Replace", shortcut: "Ctrl+F", action: () => ed.openFind() },
  ];
  if (term) {
    const short = term.length > 22 ? term.slice(0, 22) + "…" : term;
    items.push({ sep: true });
    items.push({ label: `Search MDN: “${short}” (browser)`, action: () => openExternal(mdnUrl(term, lang)) });
    items.push({ label: "Open MDN in popup", action: () => openMdnPopup(mdnUrl(term, lang), term) });
    items.push({ label: "Open MDN in editor tab", action: () => openMdnTab(mdnUrl(term, lang), short) });
  }
  popupMenu(ctxMenu, e.clientX, e.clientY, items);
}

// Generic URL tab (reuses the preview iframe view). If `html` is given it is
// shown via srcdoc (used for MDN, which refuses to be framed by URL).
function openUrlTab(url, name, html) {
  const path = "preview://" + (html != null ? "doc:" : "") + url;
  let tab = state.tabs.get(path);
  if (!tab) { tab = { path, name, kind: "preview", url, html }; state.tabs.set(path, tab); renderTabs(); }
  else { tab.url = url; tab.html = html; }
  activateTab(path);
}

async function openMdnTab(url, title) {
  toast("Loading MDN…");
  try { openUrlTab(url, "MDN: " + title, await fetchMdnDoc(url)); }
  catch (e) { toast("MDN load failed — opening in browser", true); openExternal(url); }
}

// Floating, draggable, resizable MDN popup.
let mdnPopupEl = null;
function closeMdnPopup() { if (mdnPopupEl) { mdnPopupEl.remove(); mdnPopupEl = null; } }
function openMdnPopup(url, title) {
  closeMdnPopup();
  const p = document.createElement("div");
  p.className = "mdn-popup";
  p.style.cssText = "left:140px; top:90px; width:580px; height:460px;";
  p.innerHTML = `
    <div class="mdn-bar">
      <span class="mdn-title">MDN: ${escapeHtmlText(title)}</span>
      <span class="mdn-pop-actions">
        <button data-ext title="Open in browser">↗</button>
        <button data-tab title="Move to editor tab">⤢</button>
        <button data-close title="Close">✕</button>
      </span>
    </div>
    <iframe></iframe>
    <div class="mdn-resize" title="Resize"></div>`;
  document.body.appendChild(p);
  mdnPopupEl = p;

  const frame = p.querySelector("iframe");
  fetchMdnDoc(url)
    .then((html) => { if (mdnPopupEl === p) frame.srcdoc = html; })
    .catch(() => { frame.srcdoc = `<body style="font-family:sans-serif;padding:20px;color:#333">Could not load MDN here. <a href="#" id="x">Open in browser</a></body>`; });

  const drag = (downEl, onMove) => {
    downEl.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = p.offsetLeft, oy = p.offsetTop, ow = p.offsetWidth, oh = p.offsetHeight;
      const mv = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ox, oy, ow, oh);
      const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
      window.addEventListener("mousemove", mv);
      window.addEventListener("mouseup", up);
    });
  };
  drag(p.querySelector(".mdn-bar"), (dx, dy, ox, oy) => {
    p.style.left = ox + dx + "px";
    p.style.top = Math.max(0, oy + dy) + "px";
  });
  drag(p.querySelector(".mdn-resize"), (dx, dy, ox, oy, ow, oh) => {
    p.style.width = Math.max(320, ow + dx) + "px";
    p.style.height = Math.max(220, oh + dy) + "px";
  });
  p.querySelector("[data-close]").onclick = closeMdnPopup;
  p.querySelector("[data-ext]").onclick = () => openExternal(url);
  p.querySelector("[data-tab]").onclick = () => { closeMdnPopup(); openMdnTab(url, title); };
}

// ===========================================================================
// Settings (persisted to localStorage)
// ===========================================================================
const SETTINGS_KEY = "editor-ide:settings:v1";
const DEFAULT_SETTINGS = {
  smoothScroll: false,
  treeAnimation: true,
  sqlEnabled: true,
  phpEnabled: true,
  espEnabled: false,
  espChip: "",
  espPort: "",
  espBaud: "",
  commandPaletteKey: "Ctrl+Shift+P",
};
let settings = { ...DEFAULT_SETTINGS };

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (s) settings = { ...DEFAULT_SETTINGS, ...s };
  } catch (e) {
    /* ignore */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    /* ignore */
  }
}

function applySettings() {
  if (editor) editor.setSmoothScroll(settings.smoothScroll);
  document.body.classList.toggle("no-tree-anim", !settings.treeAnimation);
  updateEspStatus();
}

function openSettings() {
  document.querySelectorAll("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === "checkbox") el.checked = !!settings[key];
    else el.value = settings[key] ?? "";
  });
  refreshSerialPorts();
  $("settings-overlay").hidden = false;
}

function closeSettings() {
  $("settings-overlay").hidden = true;
}

function wireSettingsControls() {
  document.querySelectorAll("[data-setting]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = el.dataset.setting;
      settings[key] = el.type === "checkbox" ? el.checked : el.value;
      saveSettings();
      applySettings();
    });
  });
  $("settings-close").onclick = closeSettings;
  $("settings-overlay").addEventListener("click", (e) => {
    if (e.target === $("settings-overlay")) closeSettings();
  });
  $("esp-refresh-ports").onclick = (e) => { e.preventDefault(); refreshSerialPorts(); };
}

const escapeHtmlText = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ===========================================================================
// Sidebar view switching (Explorer / Search / Source Control)
// ===========================================================================
function switchSidebar(view) {
  $("explorer-view").hidden = view !== "explorer";
  $("scm-view").hidden = view !== "scm";
  $("search-view").hidden = view !== "search";
  $("tasks-view").hidden = view !== "tasks";
  $("extensions-view").hidden = view !== "extensions";
  $("debug-view").hidden = view !== "debug";
  if (view === "scm") refreshGit();
  if (view === "debug") renderDebugView();
  if (view === "search") setTimeout(() => $("search-input")?.focus(), 0);
  if (view === "tasks") renderTasksSidebar();
  if (view === "extensions") { renderExtensions(); setTimeout(() => $("ext-search")?.focus(), 0); }
}

// ===========================================================================
// SQLite database view
// ===========================================================================
const DB_EXTS = new Set(["db", "sqlite", "sqlite3", "db3"]);
const dbView = () => $("db-view");

function isDbPath(path) {
  const ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "";
  return DB_EXTS.has(ext);
}

function hideDbView() {
  const v = dbView();
  if (v) v.hidden = true;
}

async function openDb(path, opts = {}) {
  if (state.tabs.has(path)) {
    if (!opts.defer) activateTab(path);
    return;
  }
  let tables;
  try {
    tables = await invoke("sqlite_tables", { path });
  } catch (e) {
    if (!opts.silent) toast("Cannot open database: " + e, true);
    return;
  }
  const tab = {
    path,
    name: basename(path),
    kind: "db",
    tables,
    current: tables[0] || null,
    dirty: false,
  };
  state.tabs.set(path, tab);
  renderTabs();
  if (!opts.defer) activateTab(path);
  saveSession();
}

function showDbView(tab) {
  const v = dbView();
  v.hidden = false;
  v.innerHTML = "";

  const toolbar = document.createElement("div");
  toolbar.className = "db-toolbar";
  for (const t of tab.tables) {
    const b = document.createElement("button");
    b.className = "db-tab" + (t === tab.current ? " active" : "");
    b.textContent = t;
    b.onclick = () => { tab.current = t; loadDbTable(tab); };
    toolbar.appendChild(b);
  }
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  toolbar.appendChild(spacer);
  const addBtn = document.createElement("button");
  addBtn.className = "mini-btn";
  addBtn.textContent = "+ Row";
  addBtn.onclick = () => addDbRow(tab);
  const refreshBtn = document.createElement("button");
  refreshBtn.className = "mini-btn";
  refreshBtn.textContent = "⟳";
  refreshBtn.title = "Reload";
  refreshBtn.onclick = () => loadDbTable(tab);
  toolbar.append(addBtn, refreshBtn);
  v.appendChild(toolbar);

  const wrap = document.createElement("div");
  wrap.className = "db-grid-wrap";
  wrap.id = "db-grid-wrap";
  v.appendChild(wrap);

  const qbar = document.createElement("div");
  qbar.className = "db-querybar";
  const ta = document.createElement("textarea");
  ta.id = "db-query";
  ta.placeholder = "SQL query…  (Ctrl+Enter to run)";
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); runDbQuery(tab); }
  });
  const runBtn = document.createElement("button");
  runBtn.className = "mini-btn";
  runBtn.textContent = "Run ▶";
  runBtn.onclick = () => runDbQuery(tab);
  qbar.append(ta, runBtn);
  v.appendChild(qbar);

  if (tab.current) loadDbTable(tab);
  else wrap.innerHTML = '<div class="scm-empty">No tables in this database.</div>';
}

async function loadDbTable(tab) {
  const wrap = $("db-grid-wrap");
  if (!wrap) return;
  dbView().querySelectorAll(".db-tab").forEach((b) =>
    b.classList.toggle("active", b.textContent === tab.current)
  );
  let data;
  try {
    data = await invoke("sqlite_table", { path: tab.path, table: tab.current });
  } catch (e) {
    wrap.innerHTML = `<div class="scm-empty">Error: ${escapeHtmlText(e)}</div>`;
    return;
  }
  renderDbGrid(tab, data);
}

const NULL_MARK = "\u0000null";

function renderDbGrid(tab, data) {
  const wrap = $("db-grid-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (data.truncated) {
    const n = document.createElement("div");
    n.className = "db-note";
    n.textContent = `Showing first ${data.rows.length} rows (truncated).`;
    wrap.appendChild(n);
  }
  if (!data.editable) {
    const n = document.createElement("div");
    n.className = "db-note";
    n.textContent = "Read-only result (view, query, or WITHOUT ROWID table).";
    wrap.appendChild(n);
  }

  const table = document.createElement("table");
  table.className = "db-grid";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  if (data.editable) htr.appendChild(document.createElement("th"));
  for (const c of data.columns) {
    const th = document.createElement("th");
    th.textContent = c;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  data.rows.forEach((row, ri) => {
    const tr = document.createElement("tr");
    if (data.editable) {
      const del = document.createElement("td");
      del.className = "rowmenu";
      del.textContent = "✕";
      del.title = "Delete row";
      del.onclick = () => deleteDbRow(tab, data.rowids[ri]);
      tr.appendChild(del);
    }
    row.forEach((val, ci) => {
      const td = document.createElement("td");
      const isNull = val === null;
      td.textContent = isNull ? "NULL" : String(val);
      if (isNull) td.classList.add("null");
      if (data.editable) {
        td.contentEditable = "true";
        td.dataset.col = data.columns[ci];
        td.dataset.orig = isNull ? NULL_MARK : String(val);
        td.addEventListener("focus", () => {
          if (td.classList.contains("null")) { td.textContent = ""; td.classList.remove("null"); }
        });
        td.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); td.blur(); }
        });
        td.addEventListener("blur", () => commitCell(tab, data.rowids[ri], td));
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function parseCellValue(text) {
  if (text === "") return null;
  if (/^-?\d+$/.test(text)) {
    const n = parseInt(text, 10);
    if (String(n) === text) return n;
  }
  if (/^-?\d*\.\d+$/.test(text)) return parseFloat(text);
  return text;
}

async function commitCell(tab, rowid, td) {
  const value = parseCellValue(td.textContent);
  const newRepr = value === null ? NULL_MARK : String(value);
  if (newRepr === td.dataset.orig) {
    if (value === null) { td.textContent = "NULL"; td.classList.add("null"); }
    return;
  }
  try {
    await invoke("sqlite_update_cell", {
      path: tab.path,
      table: tab.current,
      rowid,
      column: td.dataset.col,
      value,
    });
    td.dataset.orig = newRepr;
    if (value === null) { td.textContent = "NULL"; td.classList.add("null"); }
    toast("Updated " + td.dataset.col);
  } catch (e) {
    toast("Update failed: " + e, true);
    td.textContent = td.dataset.orig === NULL_MARK ? "NULL" : td.dataset.orig;
    if (td.dataset.orig === NULL_MARK) td.classList.add("null");
  }
}

async function addDbRow(tab) {
  try {
    await invoke("sqlite_insert_row", { path: tab.path, table: tab.current });
    loadDbTable(tab);
  } catch (e) {
    toast("Insert failed: " + e + " (column may require a value)", true);
  }
}

async function deleteDbRow(tab, rowid) {
  try {
    await invoke("sqlite_delete_row", { path: tab.path, table: tab.current, rowid });
    loadDbTable(tab);
  } catch (e) {
    toast("Delete failed: " + e, true);
  }
}

async function runDbQuery(tab) {
  const ta = $("db-query");
  const sql = ta.value.trim();
  if (!sql) return;
  const wrap = $("db-grid-wrap");
  try {
    const res = await invoke("sqlite_query", { path: tab.path, sql });
    if (res.affected != null) {
      tab.tables = await invoke("sqlite_tables", { path: tab.path });
      showDbView(tab);
      $("db-query").value = sql;
      $("db-grid-wrap").innerHTML =
        `<div class="scm-empty">OK — ${res.affected} row(s) affected.</div>`;
      return;
    }
    renderDbGrid(tab, {
      columns: res.columns,
      rows: res.rows,
      rowids: [],
      editable: false,
      truncated: res.truncated,
    });
  } catch (e) {
    wrap.innerHTML = `<div class="scm-empty">Error: ${escapeHtmlText(e)}</div>`;
  }
}

// ===========================================================================
// Source control (git)
// ===========================================================================
function statusChar(s) {
  if (s.includes("?")) return "U";
  return (s.trim()[0] || " ");
}
function statusClass(s) {
  if (s.includes("?")) return "untracked";
  const c = s.trim()[0];
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  return "modified";
}

function updateBranchStatus(st) {
  const el = $("status-branch");
  const ch = $("status-changes");
  const openScm = () => document.querySelector('.act-btn[data-view="scm"]').click();
  if (st && st.is_repo) {
    el.hidden = false;
    el.textContent =
      `⎇ ${st.branch}` +
      (st.ahead ? ` ↑${st.ahead}` : "") +
      (st.behind ? ` ↓${st.behind}` : "");
    el.onclick = openScm;
    const n = st.files ? st.files.length : 0;
    ch.hidden = false;
    ch.textContent = `✎ ${n}`;
    ch.title = `${n} change${n === 1 ? "" : "s"} — open Source Control`;
    ch.onclick = openScm;
  } else {
    el.hidden = true;
    ch.hidden = true;
  }
}

// Build the sets used to decorate the file tree: every changed/untracked
// file (absolute path) and every ancestor folder that contains one.
function updateGitDecorations(st) {
  state.gitChanged = new Set();
  state.gitDirs = new Set();
  state.gitIgnored = new Set();
  state.gitIgnoredDirs = [];
  if (st && st.is_repo && state.root) {
    for (const f of st.files) {
      const abs = join(state.root, f.path);
      state.gitChanged.add(abs);
      let d = dirname(abs);
      while (d && d.length > state.root.length && d !== state.root) {
        state.gitDirs.add(d);
        const parent = dirname(d);
        if (parent === d) break;
        d = parent;
      }
    }
    for (const ig of st.ignored || []) {
      const isDir = ig.endsWith("/");
      const abs = join(state.root, ig.replace(/\/+$/, ""));
      state.gitIgnored.add(abs);
      if (isDir) state.gitIgnoredDirs.push(abs + sep);
    }
  }
  renderTree();
}

// A path is ignored if it is an ignored entry itself or sits inside an
// ignored directory.
function isGitIgnored(path) {
  if (!state.gitIgnored || (!state.gitIgnored.size && !state.gitIgnoredDirs.length)) return false;
  if (state.gitIgnored.has(path)) return true;
  return state.gitIgnoredDirs.some((d) => path.startsWith(d));
}

async function loadGitStatusBar() {
  if (!state.root || state.ssh) { updateBranchStatus(null); updateGitDecorations(null); return; }
  try {
    const st = await invoke("git_status", { cwd: state.root });
    updateBranchStatus(st);
    updateGitDecorations(st);
  } catch (e) {
    updateBranchStatus(null);
    updateGitDecorations(null);
  }
}

function gitMaybeRefresh() {
  if (state.ssh) { updateBranchStatus(null); updateGitDecorations(null); return; }
  if (!$("scm-view").hidden) refreshGit();
  else loadGitStatusBar();
}

async function refreshGit() {
  const body = $("scm-body");
  if (!state.root) {
    body.innerHTML = '<div class="scm-empty">Open a folder to use source control.</div>';
    updateBranchStatus(null);
    return;
  }
  let st;
  try {
    st = await invoke("git_status", { cwd: state.root });
  } catch (e) {
    body.innerHTML = `<div class="scm-empty">git error: ${escapeHtmlText(e)}</div>`;
    return;
  }
  state._git = st;
  updateBranchStatus(st);
  updateGitDecorations(st);
  body.innerHTML = "";

  if (!st.is_repo) {
    const d = document.createElement("div");
    d.className = "scm-empty";
    d.textContent = "This folder is not a git repository.";
    const b = document.createElement("button");
    b.className = "primary-btn";
    b.style.marginTop = "10px";
    b.textContent = "Initialize Repository";
    b.onclick = async () => {
      try { await invoke("git_init", { cwd: state.root }); refreshGit(); }
      catch (e) { toast(e, true); }
    };
    d.appendChild(b);
    body.appendChild(d);
    return;
  }

  const commit = document.createElement("div");
  commit.className = "scm-commit";
  const ta = document.createElement("textarea");
  ta.id = "git-msg";
  ta.placeholder = `Message (commit on ${st.branch})`;
  const row = document.createElement("div");
  row.className = "scm-commit-actions";
  const commitBtn = document.createElement("button");
  commitBtn.className = "primary-btn";
  commitBtn.textContent = "✓ Commit";
  commitBtn.onclick = gitCommit;
  row.appendChild(commitBtn);
  commit.append(ta, row);
  body.appendChild(commit);

  const actions = document.createElement("div");
  actions.className = "scm-header-actions";
  const pull = document.createElement("button");
  pull.textContent = "⤓ Pull";
  pull.onclick = () => gitOp("git_pull", "Pulled");
  const push = document.createElement("button");
  push.textContent = st.remotes.length ? `⤒ Push${st.ahead ? ` (${st.ahead})` : ""}` : "⤒ Publish";
  push.onclick = () => (st.remotes.length ? gitOp("git_push", "Pushed") : gitPublishFlow());
  const stageAll = document.createElement("button");
  stageAll.textContent = "+ Stage All";
  stageAll.onclick = async () => {
    try { await invoke("git_stage_all", { cwd: state.root }); refreshGit(); }
    catch (e) { toast(e, true); }
  };
  actions.append(pull, push, stageAll);
  body.appendChild(actions);

  const staged = st.files.filter((f) => f.staged);
  const changes = st.files.filter((f) => !f.staged);
  if (staged.length) addScmSection(body, "Staged Changes", staged, true);
  if (changes.length) addScmSection(body, "Changes", changes, false);
  if (!st.files.length) {
    const e = document.createElement("div");
    e.className = "scm-empty";
    e.textContent = "No changes.";
    body.appendChild(e);
  }

  const r = document.createElement("div");
  r.className = "scm-remote";
  if (st.remotes.length) {
    const url = await invoke("git_get_remote", { cwd: state.root, name: st.remotes[0] }).catch(() => "");
    r.textContent = `${st.remotes[0]}: ${url}`;
    const a = document.createElement("a");
    a.textContent = "  change…";
    a.onclick = gitAddRemoteFlow;
    r.appendChild(a);
  } else {
    const a = document.createElement("a");
    a.textContent = "+ Add remote (GitHub / GitLab / custom)…";
    a.onclick = gitAddRemoteFlow;
    r.appendChild(a);
  }
  body.appendChild(r);
}

function addScmSection(body, title, files, staged) {
  const h = document.createElement("div");
  h.className = "scm-section-title";
  h.textContent = `${title} (${files.length})`;
  body.appendChild(h);
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "scm-file";
    const stat = document.createElement("span");
    stat.className = "scm-status " + statusClass(f.status);
    stat.textContent = statusChar(f.status);
    const rel = f.path.replace(/\/+$/, "");
    const isDir = f.path.endsWith("/");
    const name = document.createElement("span");
    name.className = "scm-name";
    name.textContent = (rel.slice(rel.lastIndexOf("/") + 1) || rel) + (isDir ? "/" : "");
    name.title = f.path;
    name.onclick = () => { if (!isDir && !f.status.includes("D")) openFile(join(state.root, f.path)); };
    const btn = document.createElement("button");
    btn.textContent = staged ? "−" : "+";
    btn.title = staged ? "Unstage" : "Stage";
    btn.onclick = () => gitFileOp(staged ? "git_unstage" : "git_stage", f.path);
    row.append(stat, name, btn);
    body.appendChild(row);
  }
}

async function gitFileOp(cmd, path) {
  try { await invoke(cmd, { cwd: state.root, path }); refreshGit(); }
  catch (e) { toast(e, true); }
}
async function gitOp(cmd, okMsg) {
  try { await invoke(cmd, { cwd: state.root }); toast(okMsg); refreshGit(); }
  catch (e) { toast(String(e), true); }
}
async function gitCommit() {
  const msg = $("git-msg")?.value.trim();
  if (!msg) { toast("Enter a commit message", true); return; }
  try { await invoke("git_commit", { cwd: state.root, message: msg }); toast("Committed"); refreshGit(); }
  catch (e) { toast(String(e), true); }
}
async function gitAddRemoteFlow() {
  const url = window.prompt("Remote URL (GitHub / GitLab / custom):", state._git?.remotes?.length ? "" : "https://");
  if (!url) return;
  try { await invoke("git_set_remote", { cwd: state.root, name: "origin", url: url.trim() }); toast("Remote set"); refreshGit(); }
  catch (e) { toast(String(e), true); }
}
async function gitPublishFlow() {
  if (!state._git?.remotes?.length) { await gitAddRemoteFlow(); }
  try { await invoke("git_publish", { cwd: state.root }); toast("Published"); refreshGit(); }
  catch (e) { toast(String(e), true); }
}

// ===========================================================================
// Search across files
// ===========================================================================
let searchTimer = null;

function runSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 220);
}

async function doSearch() {
  const results = $("search-results");
  const query = $("search-input").value;
  if (!state.root) { results.innerHTML = '<div class="scm-empty">Open a folder first.</div>'; return; }
  if (!query.trim()) { results.innerHTML = ""; return; }
  const caseSensitive = $("search-case").classList.contains("active");
  let hits;
  try {
    hits = await invoke("search_files", { root: state.root, query, caseSensitive, maxResults: 500 });
  } catch (e) {
    results.innerHTML = `<div class="scm-empty">Error: ${escapeHtmlText(e)}</div>`;
    return;
  }
  if (!hits.length) { results.innerHTML = '<div class="scm-empty">No results.</div>'; return; }

  // Group hits by file.
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.path)) byFile.set(h.path, []);
    byFile.get(h.path).push(h);
  }
  results.innerHTML = "";
  const total = document.createElement("div");
  total.className = "scm-section-title";
  total.textContent = `${hits.length} result(s) in ${byFile.size} file(s)`;
  results.appendChild(total);

  for (const [path, fileHits] of byFile) {
    const fileEl = document.createElement("div");
    fileEl.className = "search-file";
    fileEl.textContent = `${basename(path)} · ${fileHits.length}`;
    fileEl.title = path;
    results.appendChild(fileEl);
    for (const h of fileHits) {
      const line = document.createElement("div");
      line.className = "search-hit";
      const ln = document.createElement("span");
      ln.className = "search-ln";
      ln.textContent = h.line;
      const txt = document.createElement("span");
      txt.className = "search-text";
      txt.textContent = h.text.trim();
      line.append(ln, txt);
      line.onclick = async () => {
        await openFile(path);
        const tab = state.tabs.get(path);
        if (tab && tab.kind !== "db" && editor) editor.setCursor({ line: h.line - 1, col: 0 });
      };
      results.appendChild(line);
    }
  }
}

// ===========================================================================
// Integrated terminal (xterm + PTY)
// ===========================================================================
let termCounter = 0;
let activeTermId = null;
let visibleTerms = [];   // panel terminal ids shown side-by-side (split)
const TERM_SAVE_CHARS = 4000; // how much recent terminal output to persist
const terminals = new Map(); // id -> { term, fit, el, offData, offExit, title, location }

function panelTerminals() {
  return [...terminals.entries()].filter(([, t]) => t.location === "panel");
}

function toggleTerminal() {
  if ($("terminal-panel").hidden) openTerminalPanel();
  else hideTerminalPanel();
}

function openTerminalPanel() {
  $("terminal-panel").hidden = false;
  $("editor-area").classList.add("with-terminal");
  if (panelTerminals().length === 0) newTerminal();
  else activateTerminal(activeTermId);
}

function hideTerminalPanel() {
  $("terminal-panel").hidden = true;
  $("editor-area").classList.remove("with-terminal", "term-max");
}

function toggleTerminalMax() {
  $("editor-area").classList.toggle("term-max");
  setTimeout(() => visibleTerms.forEach((id) => { try { terminals.get(id)?.fit.fit(); } catch (e) {} }), 0);
}

async function newTerminal(opts = {}) {
  if (typeof Terminal === "undefined") { toast("Terminal library failed to load.", true); return; }
  $("terminal-panel").hidden = false;
  $("editor-area").classList.add("with-terminal");
  const id = "t" + (++termCounter);
  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: "#181818", foreground: "#d4d4d4" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);

  const el = document.createElement("div");
  el.className = "term-instance";
  el.dataset.id = id;
  $("terminal-host").appendChild(el);
  term.open(el);

  // restored scrollback (printed before the fresh shell starts)
  if (opts.initial) term.write(opts.initial + "\r\n\x1b[90m── session restored ──\x1b[0m\r\n");

  const listen = TAURI.event.listen;
  const offData = await listen(`term-data:${id}`, (e) => {
    term.write(e.payload);
    const tt = terminals.get(id);
    if (tt) tt.outBuf = ((tt.outBuf || "") + e.payload).slice(-TERM_SAVE_CHARS);
  });
  const offExit = await listen(`term-exit:${id}`, () => term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"));
  term.onData((d) => { invoke("term_write", { id, data: d }); trackTermInput(id, d); });
  term.onResize(({ cols, rows }) => invoke("term_resize", { id, cols, rows }));

  try {
    await invoke("term_open", { id, cwd: state.root || null, cols: term.cols || 80, rows: term.rows || 24 });
  } catch (e) {
    toast("Could not start terminal: " + e, true);
    el.remove();
    return;
  }
  terminals.set(id, { term, fit, el, offData, offExit, title: "Terminal " + termCounter, location: "panel", outBuf: opts.initial || "" });
  activeTermId = id;
  if (opts.split && visibleTerms.length) {
    visibleTerms.push(id);
    renderTermTabs();
    renderTermPanes();
    updateTermName();
    term.focus();
  } else {
    activateTerminal(id);
  }
}

function splitTerminal() {
  if (!panelTerminals().length) newTerminal();
  else newTerminal({ split: true });
}

function renderTermPanes() {
  for (const [tid, t] of terminals) {
    if (t.location !== "panel") continue;
    const vis = visibleTerms.includes(tid);
    t.el.style.display = vis ? "block" : "none";
    t.el.style.flex = vis ? "1 1 0" : "0";
    t.el.style.minWidth = "0";
  }
  // fit after layout settles (the right strip may have just appeared/changed
  // the available width — fitting too early overflows the terminal off-screen)
  requestAnimationFrame(() => {
    for (const id of visibleTerms) {
      const t = terminals.get(id);
      if (t) { try { t.fit.fit(); } catch (e) { /* ignore */ } }
    }
  });
}

function updateTermName() {
  const el = $("term-active-name");
  if (!el) return;
  const t = terminals.get(activeTermId);
  el.textContent = t ? t.title : "Terminal";
  el.dataset.id = activeTermId || "";
}

// Track typed input so the terminal title reflects the command being run.
function trackTermInput(id, d) {
  const t = terminals.get(id);
  if (!t) return;
  if (t.inputBuf == null) t.inputBuf = "";
  for (const ch of d) {
    if (ch === "\r" || ch === "\n") {
      const line = t.inputBuf.trim();
      t.inputBuf = "";
      if (line) {
        const cmd = line.split(/\s+/)[0].split("/").pop();
        if (cmd) setTermTitle(id, cmd);
      }
    } else if (ch === "\x7f" || ch === "\b") {
      t.inputBuf = t.inputBuf.slice(0, -1);
    } else if (ch === "\x03" || ch === "\x15") {
      t.inputBuf = ""; // Ctrl+C / Ctrl+U
    } else if (ch === "\x1b") {
      break; // escape sequence (arrows etc.)
    } else if (ch >= " ") {
      t.inputBuf += ch;
    }
  }
}

function setTermTitle(id, title) {
  const t = terminals.get(id);
  if (!t) return;
  t.title = title;
  if (id === activeTermId) updateTermName();
  renderTermTabs();
  const tab = state.tabs.get("term://" + id);
  if (tab) { tab.name = title; renderTabs(); }
}

function renderTermTabs() {
  const strip = $("terminal-tabs-strip");
  if (!strip) return;
  strip.innerHTML = "";
  const list = panelTerminals();
  strip.style.display = list.length > 1 ? "block" : "none";
  for (const [id, t] of list) {
    const tab = document.createElement("div");
    tab.className = "term-tab" + (visibleTerms.includes(id) ? " active" : "");
    tab.draggable = true;
    tab.addEventListener("dragstart", (e) => e.dataTransfer.setData("application/x-bicode-term", id));
    const label = document.createElement("span");
    label.className = "term-tab-label";
    label.textContent = t.title;
    label.onclick = () => activateTerminal(id);
    const move = document.createElement("button");
    move.className = "term-tab-btn";
    move.textContent = "⤢";
    move.title = "Move to editor area";
    move.onclick = (e) => { e.stopPropagation(); moveTerminalToEditor(id); };
    const close = document.createElement("button");
    close.className = "term-tab-btn";
    close.textContent = "✕";
    close.title = "Kill terminal";
    close.onclick = (e) => { e.stopPropagation(); closeTerminal(id); };
    tab.append(label, move, close);
    strip.appendChild(tab);
  }
}

function activateTerminal(id) {
  if (!terminals.has(id) || terminals.get(id).location !== "panel") {
    const first = panelTerminals()[0];
    id = first ? first[0] : null;
  }
  activeTermId = id;
  visibleTerms = id ? [id] : [];
  renderTermTabs();   // toggle the right strip first so the width is final
  renderTermPanes();  // then fit panes to the settled width
  updateTermName();
  const t = terminals.get(id);
  if (t) t.term.focus();
}

async function closeTerminal(id) {
  const t = terminals.get(id);
  if (!t) return;
  try { t.offData?.(); t.offExit?.(); } catch (e) { /* ignore */ }
  try { await invoke("term_close", { id }); } catch (e) { /* ignore */ }
  t.term.dispose();
  t.el.remove();
  terminals.delete(id);
  visibleTerms = visibleTerms.filter((x) => x !== id);
  const tabPath = "term://" + id;
  if (state.tabs.has(tabPath)) { state.tabs.delete(tabPath); if (state.active === tabPath) state.active = null; renderTabs(); if (!state.active) showWelcome(); }
  if (activeTermId === id) activeTermId = visibleTerms[0] || null;
  if (panelTerminals().length) {
    if (!visibleTerms.length) activateTerminal(panelTerminals()[0][0]);
    else { renderTermPanes(); renderTermTabs(); updateTermName(); }
  } else if (!terminals.size) {
    hideTerminalPanel();
  }
}

function fitActiveTerm() {
  visibleTerms.forEach((id) => { const t = terminals.get(id); if (t) { try { t.fit.fit(); } catch (e) {} } });
}

// ----- move a terminal between the bottom panel and the editor tab area -----
function moveTerminalToEditor(id) {
  const t = terminals.get(id);
  if (!t) return;
  t.location = "editor";
  visibleTerms = visibleTerms.filter((x) => x !== id);
  const path = "term://" + id;
  if (!state.tabs.has(path)) {
    state.tabs.set(path, { path, name: t.title, kind: "terminal", termId: id });
    renderTabs();
  }
  if (panelTerminals().length === 0) hideTerminalPanel();
  else activateTerminal(panelTerminals()[0][0]);
  activateTab(path);
}

function moveTerminalToPanel(id) {
  const t = terminals.get(id);
  if (!t) return;
  t.location = "panel";
  $("terminal-host").appendChild(t.el);
  openTerminalPanel();
  activateTerminal(id);
}

function showTerminalView(tab) {
  const host = $("terminal-editor-host");
  host.hidden = false;
  const t = terminals.get(tab.termId);
  if (!t) return;
  if (t.el.parentElement !== host) host.appendChild(t.el);
  t.el.style.display = "block";
  t.el.style.flex = "none";
  // after the reparent + layout, refit and force xterm to repaint its buffer
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { t.fit.fit(); } catch (e) { /* ignore */ }
    try { t.term.refresh(0, t.term.rows - 1); } catch (e) { /* ignore */ }
    try { t.term.scrollToBottom(); } catch (e) { /* ignore */ }
    t.term.focus();
  }));
}
function hideTerminalView() {
  const host = $("terminal-editor-host");
  if (host) host.hidden = true;
}

function showTerminalMenu(btn) {
  const rect = btn.getBoundingClientRect();
  popupMenu(dropdown, rect.left, rect.bottom, [
    { label: "New Terminal", action: () => newTerminal() },
    { label: "Toggle Terminal", shortcut: "Ctrl+`", action: toggleTerminal },
  ]);
}

// ===========================================================================
// ESP32 flashing over USB
// ===========================================================================
async function refreshSerialPorts() {
  const sel = $("esp-port");
  if (!sel) return;
  let ports = [];
  try { ports = await invoke("serial_ports"); } catch (e) { /* ignore */ }
  const cur = settings.espPort;
  sel.innerHTML = "";
  if (!ports.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "(no ports found)";
    sel.appendChild(o);
  }
  for (const p of ports) {
    const o = document.createElement("option");
    o.value = p; o.textContent = p;
    sel.appendChild(o);
  }
  if (cur) sel.value = cur;
}

function updateEspStatus() {
  const el = $("status-esp");
  if (settings.espEnabled) {
    el.hidden = false;
    el.textContent = "⚡ Flash ESP";
    el.onclick = espFlashFlow;
  } else {
    el.hidden = true;
  }
}

async function espFlashFlow() {
  let image;
  const at = state.active && state.tabs.get(state.active);
  if (at && /\.(bin|elf|hex)$/i.test(at.path)) image = at.path;
  else {
    image = await openDialog({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "elf", "hex"] }],
    });
  }
  if (!image) return;
  if (!settings.espPort) { toast("Select a serial port in Settings first.", true); openSettings(); return; }

  openTerminalPanel();
  toast("Flashing " + basename(image) + "…");
  try {
    await invoke("esp_flash", {
      port: settings.espPort,
      chip: settings.espChip || null,
      image,
      baud: settings.espBaud ? parseInt(settings.espBaud, 10) : null,
    });
  } catch (e) {
    toast("Flash error: " + e, true);
  }
}

function wireEspEvents() {
  const listen = TAURI.event.listen;
  listen("esp-log", (e) => {
    const t = terminals.get(activeTermId);
    if (t) t.term.write("\x1b[33m" + e.payload + "\x1b[0m\r\n");
  });
  listen("esp-done", (e) => toast(e.payload ? "Flash complete ✓" : "Flash failed ✗", !e.payload));
}

// ===========================================================================
// Live Server
// ===========================================================================
let liveServerPort = null;

async function toggleLiveServer() {
  if (!state.root) { toast("Open a folder first.", true); return; }
  if (liveServerPort) {
    try { await invoke("live_server_stop"); } catch (e) { /* ignore */ }
    liveServerPort = null;
    updateLiveStatus();
    toast("Live Server stopped");
    return;
  }
  try {
    liveServerPort = await invoke("live_server_start", { root: state.root, php: settings.phpEnabled });
    updateLiveStatus();
    const url = `http://localhost:${liveServerPort}/`;
    toast("Live Server: " + url);
    openPreviewTab(url);
  } catch (e) {
    toast("Live Server failed: " + e, true);
  }
}

// ===========================================================================
// In-IDE preview tab (iframe over the live server)
// ===========================================================================
const PREVIEW_PATH = "preview://live";

function hidePreview() {
  const v = $("preview-view");
  if (v) v.hidden = true;
}

function openPreviewTab(url) {
  let tab = state.tabs.get(PREVIEW_PATH);
  if (!tab) {
    tab = { path: PREVIEW_PATH, name: "Preview", kind: "preview", url };
    state.tabs.set(PREVIEW_PATH, tab);
    renderTabs();
  } else {
    tab.url = url;
  }
  activateTab(PREVIEW_PATH);
}

function showPreview(tab) {
  const v = $("preview-view");
  v.hidden = false;
  const frame = $("preview-frame");
  $("preview-url").value = tab.url || "";
  if (frame.dataset.loaded === tab.path) return;
  frame.dataset.loaded = tab.path;
  if (tab.html != null) { frame.removeAttribute("src"); frame.srcdoc = tab.html; }
  else { frame.removeAttribute("srcdoc"); frame.src = tab.url; }
}

// ===========================================================================
// Image / SVG viewer
// ===========================================================================
const IMG_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
function isImagePath(p) {
  const e = p.includes(".") ? p.split(".").pop().toLowerCase() : "";
  return IMG_EXTS.has(e);
}
const imageMime = (ext) =>
  ({ png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", bmp: "bmp", ico: "x-icon", svg: "svg+xml" }[ext] || "png");
const b64utf8 = (s) => btoa(unescape(encodeURIComponent(s)));

function hideImageView() {
  const v = $("image-view");
  if (v) v.hidden = true;
  $("svg-toggle").hidden = true;
}

async function openImage(path, opts = {}) {
  if (state.tabs.has(path)) { if (!opts.defer) activateTab(path); return; }
  const ext = path.split(".").pop().toLowerCase();
  let tab;
  try {
    if (ext === "svg") {
      const content = await fsRead(path);
      tab = {
        path, name: basename(path), kind: "image", isSvg: true, mode: "preview",
        content, saved: content, dirty: false, cursor: { line: 0, col: 0 }, lang: "html",
        dataUrl: "data:image/svg+xml;base64," + b64utf8(content),
      };
    } else {
      const b64 = await fsReadBase64(path);
      tab = { path, name: basename(path), kind: "image", dataUrl: `data:image/${imageMime(ext)};base64,${b64}` };
    }
  } catch (e) {
    if (!opts.silent) toast("Cannot open image: " + e, true);
    return;
  }
  state.tabs.set(path, tab);
  renderTabs();
  if (!opts.defer) activateTab(path);
  saveSession();
}

function showImageView(tab) {
  if (editor) editor.style.display = "none";
  hideDbView(); hidePreview(); hideExtensionView(); hideTerminalView();
  const v = $("image-view");
  v.hidden = false;
  const wrap = v.querySelector(".image-wrap");
  if (tab.isSvg) {
    // inline the SVG markup — reliable rendering & scaling even when the file
    // declares no width/height (which would make an <img> collapse to 0).
    wrap.innerHTML = tab.content;
  } else {
    wrap.innerHTML = '<img alt="" />';
    wrap.querySelector("img").src = tab.dataUrl;
  }
}

function showSvgToggle(tab) {
  const b = $("svg-toggle");
  if (tab && tab.kind === "image" && tab.isSvg) {
    b.hidden = false;
    b.textContent = tab.mode === "preview" ? "</>  Code" : "◑  Preview";
  } else {
    b.hidden = true;
  }
}

// ===========================================================================
// Breadcrumb (path bar above the editor)
// ===========================================================================
function updateBreadcrumb(tab) {
  const bc = $("breadcrumb");
  const synthetic = tab && tab.path && /^(ext|preview|term):\/\//.test(tab.path);
  if (!tab || !tab.path || synthetic) { bc.hidden = true; bc.innerHTML = ""; return; }

  let rel = tab.path;
  if (state.root && tab.path.startsWith(state.root)) rel = tab.path.slice(state.root.length);
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length) { bc.hidden = true; bc.innerHTML = ""; return; }

  bc.innerHTML = "";
  parts.forEach((p, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "bc-sep";
      sep.textContent = "›";
      bc.appendChild(sep);
    }
    const seg = document.createElement("span");
    seg.className = "bc-seg";
    if (i === parts.length - 1) {
      seg.classList.add("bc-file");
      seg.innerHTML = fileIconSvg(p) + `<span>${escapeHtmlText(p)}</span>`;
    } else {
      seg.textContent = p;
    }
    bc.appendChild(seg);
  });
  bc.hidden = false;
}

function updateLiveStatus() {
  const el = $("status-live");
  if (!state.root || state.ssh) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = liveServerPort ? `◉ Live :${liveServerPort}` : "Go Live";
  el.onclick = toggleLiveServer;
}

// ===========================================================================
// Custom command tasks (e.g. "cargo run"), split global / workspace
// ===========================================================================
const GLOBAL_TASKS_KEY = "editor-ide:tasks:global";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tasksKey(scope) {
  if (scope === "global") return GLOBAL_TASKS_KEY;
  return state.root ? "editor-ide:tasks:ws:" + state.root : null;
}
function loadTasks(scope) {
  const key = tasksKey(scope);
  if (!key) return [];
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; }
}
function storeTasks(scope, list) {
  const key = tasksKey(scope);
  if (key) localStorage.setItem(key, JSON.stringify(list));
}
function allTasks() {
  return [
    ...loadTasks("global").map((t) => ({ ...t, scope: "global" })),
    ...loadTasks("workspace").map((t) => ({ ...t, scope: "workspace" })),
  ];
}

async function runTask(command) {
  if (!command) return;
  if (terminals.size === 0) { await newTerminal(); await sleep(500); }
  else openTerminalPanel();
  if (!activeTermId) return;
  try { await invoke("term_write", { id: activeTermId, data: command + "\r" }); }
  catch (e) { toast("Run failed: " + e, true); }
}

function renderTasksSidebar() {
  const host = $("tasks-sidebar");
  if (!host) return;
  host.innerHTML = "";
  const groups = [
    ["Workspace", "workspace"],
    ["Global", "global"],
  ];
  let any = false;
  for (const [label, scope] of groups) {
    const items = loadTasks(scope);
    if (scope === "workspace" && !state.root) continue;
    const h = document.createElement("div");
    h.className = "scm-section-title";
    h.textContent = label;
    host.appendChild(h);
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "scm-empty";
      e.textContent = "No commands.";
      host.appendChild(e);
      continue;
    }
    items.forEach((t, i) => {
      any = true;
      const row = document.createElement("div");
      row.className = "task-srow";
      const run = document.createElement("button");
      run.className = "task-srow-run";
      run.innerHTML = `<span class="task-srow-name">▶ ${escapeHtmlText(t.name)}</span><span class="task-srow-cmd">${escapeHtmlText(t.command)}</span>`;
      run.title = `Run: ${t.command}`;
      run.onclick = () => runTask(t.command);
      const del = document.createElement("button");
      del.className = "task-srow-del";
      del.textContent = "✕";
      del.title = "Delete";
      del.onclick = () => {
        const arr = loadTasks(scope);
        arr.splice(i, 1);
        storeTasks(scope, arr);
        renderTasksSidebar();
      };
      row.append(run, del);
      host.appendChild(row);
    });
  }

  // Detected commands (package.json scripts) — run in the workspace.
  renderDetectedTasks(host);
}

// Detect the workspace package manager from lockfiles in the root.
function detectPackageManager() {
  const names = new Set((state.treeCache.get(state.root) || []).map((e) => e.name));
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  if (names.has("bun.lockb")) return "bun";
  return "npm";
}

async function renderDetectedTasks(host) {
  if (!state.root || state.ssh) return; // detected scripts run in the local terminal
  let scripts = null;
  try {
    const txt = await fsRead(join(state.root, "package.json"));
    scripts = (JSON.parse(txt).scripts) || {};
  } catch (e) { return; } // no package.json / unreadable
  const names = Object.keys(scripts);
  if (!names.length || $("tasks-view").hidden) return;

  const pm = detectPackageManager();
  const h = document.createElement("div");
  h.className = "scm-section-title";
  h.textContent = "Detected commands (package.json)";
  host.appendChild(h);

  for (const name of names) {
    // run in the package.json's location (workspace root)
    const command = `cd "${state.root}" && ${pm} run ${name}`;
    const row = document.createElement("div");
    row.className = "task-srow";
    const run = document.createElement("button");
    run.className = "task-srow-run";
    run.innerHTML = `<span class="task-srow-name">▶ ${escapeHtmlText(name)}</span><span class="task-srow-cmd">${escapeHtmlText(scripts[name])}</span>`;
    run.title = `Run: ${command}`;
    run.onclick = () => runTask(command);
    row.append(run);
    host.appendChild(row);
  }
}

// ---- task manager modal ----
let taskEditScope = "workspace";

function openTasks() {
  $("tasks-overlay").hidden = false;
  taskEditScope = state.root ? "workspace" : "global";
  $("task-name").value = "";
  $("task-cmd").value = "";
  syncTaskScopeButtons();
  renderTaskList();
}
function closeTasks() { $("tasks-overlay").hidden = true; }

function syncTaskScopeButtons() {
  document.querySelectorAll(".task-scope-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.scope === taskEditScope)
  );
  const wsBtn = document.querySelector('.task-scope-btn[data-scope="workspace"]');
  if (wsBtn) wsBtn.disabled = !state.root;
}

function renderTaskList() {
  const list = $("task-list");
  list.innerHTML = "";
  const groups = [
    ["Global", "global"],
    ["Workspace", "workspace"],
  ];
  for (const [label, scope] of groups) {
    const items = loadTasks(scope);
    const h = document.createElement("div");
    h.className = "scm-section-title";
    h.textContent = `${label}${scope === "workspace" && !state.root ? " (no folder open)" : ""}`;
    list.appendChild(h);
    if (!items.length) {
      const e = document.createElement("div");
      e.className = "scm-empty";
      e.textContent = "No commands.";
      list.appendChild(e);
      continue;
    }
    items.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "task-row";
      const name = document.createElement("span");
      name.className = "task-row-name";
      name.textContent = t.name;
      const cmd = document.createElement("span");
      cmd.className = "task-row-cmd";
      cmd.textContent = t.command;
      const run = document.createElement("button");
      run.className = "mini-btn"; run.textContent = "▶";
      run.onclick = () => { closeTasks(); runTask(t.command); };
      const del = document.createElement("button");
      del.className = "mini-btn"; del.textContent = "✕";
      del.onclick = () => { const arr = loadTasks(scope); arr.splice(i, 1); storeTasks(scope, arr); renderTaskList(); renderTasksSidebar(); };
      row.append(name, cmd, run, del);
      list.appendChild(row);
    });
  }
}

function addTask() {
  const name = $("task-name").value.trim();
  const command = $("task-cmd").value.trim();
  if (!name || !command) { toast("Enter a name and a command", true); return; }
  if (taskEditScope === "workspace" && !state.root) { toast("Open a folder for a workspace command", true); return; }
  const arr = loadTasks(taskEditScope);
  arr.push({ id: "c" + Date.now(), name, command });
  storeTasks(taskEditScope, arr);
  $("task-name").value = "";
  $("task-cmd").value = "";
  renderTaskList();
  renderTasksSidebar();
  toast("Added " + name);
}

// ===========================================================================
// Command palette
// ===========================================================================
let paletteCmds = [];
let paletteIndex = 0;

function clickActAndFocus(view) {
  const b = document.querySelector(`.act-btn[data-view="${view}"]`);
  if (b) b.click();
}

function getCommands() {
  const base = [
    { title: "File: Open Folder…", run: openFolder },
    { title: "File: Open Recent…", run: () => showRecentMenu($("menu").querySelector('[data-menu="file"]')) },
    { title: "File: Open SSH Folder…", run: openSshModal },
    { title: "File: Close Remote (SSH)", run: sshDisconnect, when: () => !!state.ssh },
    { title: "File: New File", run: () => newFile(targetDirFor(state.selected) || state.root), when: () => !!state.root },
    { title: "File: New Folder", run: () => newFolder(targetDirFor(state.selected) || state.root), when: () => !!state.root },
    { title: "File: Save", run: saveActive, when: () => !!state.active },
    { title: "View: Close Editor", run: () => state.active && closeTab(state.active), when: () => !!state.active },
    { title: "View: Show Explorer", run: () => clickActAndFocus("explorer") },
    { title: "View: Show Search", run: () => clickActAndFocus("search") },
    { title: "View: Show Source Control", run: () => clickActAndFocus("scm") },
    { title: "Preferences: Open Settings", run: openSettings },
    { title: "Preferences: Color Theme", run: openThemeQuickPick },
    { title: "Themes: Browse (Open VSX)", run: () => clickActAndFocus("extensions") },
    { title: "Terminal: Toggle", run: toggleTerminal },
    { title: "Terminal: New Terminal", run: () => newTerminal() },
    { title: "Tasks: Manage Commands…", run: openTasks },
    { title: "Live Server: Toggle", run: toggleLiveServer, when: () => !!state.root },
    { title: "Git: Refresh", run: refreshGit, when: () => !!state.root },
    { title: "Git: Commit…", run: () => { clickActAndFocus("scm"); setTimeout(() => $("git-msg")?.focus(), 60); }, when: () => !!state.root },
    { title: "Git: Push", run: () => gitOp("git_push", "Pushed"), when: () => !!state.root },
    { title: "Git: Pull", run: () => gitOp("git_pull", "Pulled"), when: () => !!state.root },
    { title: "Git: Publish / Set Remote…", run: gitPublishFlow, when: () => !!state.root },
    { title: "ESP32: Flash Firmware", run: espFlashFlow, when: () => settings.espEnabled },
    { title: "Editor: Toggle Smooth Scrolling", run: () => { settings.smoothScroll = !settings.smoothScroll; saveSettings(); applySettings(); toast("Smooth scroll " + (settings.smoothScroll ? "on" : "off")); } },
  ];
  const tasks = allTasks().map((t) => ({ title: `Run Task: ${t.name}  (${t.scope})`, run: () => runTask(t.command) }));
  return [...base, ...tasks].filter((c) => !c.when || c.when());
}

function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const s = text.toLowerCase();
  if (!q) return 0;
  let ti = 0, score = 0, streak = 0;
  for (const ch of q) {
    let found = -1;
    for (let j = ti; j < s.length; j++) { if (s[j] === ch) { found = j; break; } }
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak;
    ti = found + 1;
  }
  return score;
}

function openPalette() {
  $("palette-overlay").hidden = false;
  const input = $("palette-input");
  input.value = "";
  renderPalette("");
  input.focus();
}
function closePalette() { $("palette-overlay").hidden = true; }

function renderPalette(query) {
  const list = $("palette-list");
  const all = getCommands();
  let scored;
  if (!query.trim()) scored = all.map((c) => ({ c, s: 0 }));
  else scored = all.map((c) => ({ c, s: fuzzyScore(query, c.title) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
  paletteCmds = scored.map((x) => x.c);
  paletteIndex = 0;
  list.innerHTML = "";
  if (!paletteCmds.length) { list.innerHTML = '<div class="palette-empty">No matching commands</div>'; return; }
  paletteCmds.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "palette-item" + (i === 0 ? " active" : "");
    el.textContent = c.title;
    el.onmousedown = (e) => { e.preventDefault(); runPalette(i); };
    list.appendChild(el);
  });
}

function movePalette(d) {
  if (!paletteCmds.length) return;
  paletteIndex = (paletteIndex + d + paletteCmds.length) % paletteCmds.length;
  const items = $("palette-list").children;
  for (let i = 0; i < items.length; i++) items[i].classList.toggle("active", i === paletteIndex);
  items[paletteIndex]?.scrollIntoView({ block: "nearest" });
}

function runPalette(i) {
  const c = paletteCmds[i != null ? i : paletteIndex];
  closePalette();
  if (c) { try { c.run(); } catch (e) { toast(String(e), true); } }
}

// ---- keyboard chord helpers (configurable shortcut) ----
function chordFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");
  const k = e.key;
  if (!["Control", "Shift", "Alt", "Meta"].includes(k)) parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}
function matchChord(e, chord) {
  if (!chord) return false;
  const parts = chord.toLowerCase().split("+").map((s) => s.trim());
  const key = parts[parts.length - 1];
  if (!!e.ctrlKey !== parts.includes("ctrl")) return false;
  if (!!e.shiftKey !== parts.includes("shift")) return false;
  if (!!e.altKey !== parts.includes("alt")) return false;
  if (!!e.metaKey !== (parts.includes("meta") || parts.includes("cmd"))) return false;
  return e.key.toLowerCase() === key || e.code.toLowerCase() === "key" + key;
}

// ===========================================================================
// Color themes (pulled from the Open VSX registry, VSCode theme format)
// ===========================================================================
const THEME_KEY = "editor-ide:theme:v1";
const UI_VARS = {
  bg: "--bg", bgAlt: "--bg-alt", titlebar: "--bg-titlebar", activity: "--bg-activity",
  statusbar: "--bg-statusbar", fg: "--fg", fgDim: "--fg-dim", fgBright: "--fg-bright",
  accent: "--accent", border: "--border", borderLight: "--border-light",
  hover: "--hover", selected: "--selected", tabActive: "--tab-active", tabInactive: "--tab-inactive",
  inputBg: "--input-bg", btnBg: "--btn-bg",
};
const TOKEN_SEL = {
  keyword1: ".keyword1", keyword2: ".keyword2", keyword3: ".keyword3",
  number: ".number", string: ".string", comment: ".comment",
  function: ".function", type: ".type", operator: ".operator",
};

function stripJsonc(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}
function parseThemeFile(text) {
  try { return JSON.parse(text); } catch (e) { return JSON.parse(stripJsonc(text)); }
}

function scopeColorFn(tokenColors) {
  return (wants) => {
    for (const want of wants) {
      for (const t of tokenColors) {
        if (!t.settings || !t.settings.foreground) continue;
        const s = t.scope;
        const list = Array.isArray(s) ? s : typeof s === "string" ? s.split(",").map((x) => x.trim()) : [];
        if (list.some((sc) => sc === want || sc.startsWith(want + ".") || want.startsWith(sc + "."))) {
          return t.settings.foreground;
        }
      }
    }
    return null;
  };
}

function normalizeVscodeTheme(raw, name) {
  const colors = raw.colors || {};
  const sc = scopeColorFn(raw.tokenColors || []);
  const eBg = colors["editor.background"];
  const eFg = colors["editor.foreground"];
  const isLight = (raw.type || "dark") === "light";
  return {
    name,
    type: raw.type || "dark",
    ui: {
      bg: eBg,
      bgAlt: colors["sideBar.background"] || eBg,
      titlebar: colors["titleBar.activeBackground"] || colors["editorGroupHeader.tabsBackground"],
      activity: colors["activityBar.background"],
      statusbar: colors["statusBar.background"],
      fg: colors["foreground"] || eFg,
      fgDim: colors["descriptionForeground"] || colors["tab.inactiveForeground"],
      fgBright: eFg,
      accent: colors["focusBorder"] || colors["statusBar.background"] || colors["button.background"],
      border: colors["editorGroup.border"] || colors["panel.border"] || colors["sideBar.border"],
      borderLight: colors["input.border"] || colors["panel.border"],
      hover: colors["list.hoverBackground"],
      selected: colors["list.activeSelectionBackground"],
      tabActive: colors["tab.activeBackground"] || eBg,
      tabInactive: colors["tab.inactiveBackground"],
      inputBg: colors["input.background"] || (isLight ? "#ffffff" : "#3c3c3c"),
      btnBg: colors["dropdown.background"] || colors["input.background"] || (isLight ? "#e4e4e4" : "#3a3d41"),
    },
    editor: {
      bg: eBg,
      fg: eFg,
      wordHl: colors["editor.wordHighlightBackground"] || colors["editor.selectionHighlightBackground"],
      bracket: colors["editorBracketMatch.border"] || colors["editorBracketMatch.background"],
    },
    tokens: {
      comment: sc(["comment"]),
      string: sc(["string"]),
      number: sc(["constant.numeric", "constant"]),
      keyword1: sc(["storage.type", "storage", "keyword"]),
      keyword2: sc(["keyword.control", "keyword"]),
      keyword3: sc(["constant.language", "variable.language", "support.constant"]),
      function: sc(["entity.name.function", "support.function", "meta.function-call"]),
      type: sc(["entity.name.type", "support.type", "entity.name.class", "support.class"]),
      operator: sc(["keyword.operator"]),
    },
  };
}

// Remove every theme-controlled CSS variable so anything the next theme does
// not define falls back to the built-in default (instead of lingering from the
// previously applied theme).
function clearThemeVars() {
  const root = document.documentElement.style;
  Object.values(UI_VARS).forEach((v) => root.removeProperty(v));
  root.removeProperty("--ce-word-hl");
  root.removeProperty("--ce-bracket");
}

function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement.style;
  clearThemeVars(); // reset to defaults first, then layer this theme on top
  for (const [k, v] of Object.entries(theme.ui || {})) {
    if (v && UI_VARS[k]) root.setProperty(UI_VARS[k], v);
  }
  let css = "";
  if (theme.editor?.bg) css += `#app code-editor { background: ${theme.editor.bg}; }\n`;
  if (theme.editor?.fg) css += `#app code-editor { color: ${theme.editor.fg}; }\n`;
  if (theme.editor?.wordHl) root.setProperty("--ce-word-hl", theme.editor.wordHl);
  if (theme.editor?.bracket) root.setProperty("--ce-bracket", theme.editor.bracket);
  for (const [k, sel] of Object.entries(TOKEN_SEL)) {
    if (theme.tokens?.[k]) css += `#app code-editor ${sel} { color: ${theme.tokens[k]}; }\n`;
  }
  let style = $("ide-theme");
  if (!style) { style = document.createElement("style"); style.id = "ide-theme"; document.head.appendChild(style); }
  style.textContent = css;
  const cur = $("theme-current");
  if (cur) cur.textContent = theme.name ? "· " + theme.name : "";
}

function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch (e) { /* ignore */ }
}
function loadStoredTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) || "null");
    if (t) applyTheme(t);
  } catch (e) { /* ignore */ }
}
function resetTheme() {
  localStorage.removeItem(THEME_KEY);
  clearThemeVars();
  const style = $("ide-theme");
  if (style) style.textContent = "";
  const cur = $("theme-current");
  if (cur) cur.textContent = "";
  toast("Theme reset to default");
}

// ----- built-in themes (cannot be uninstalled) -----
const BUILTIN_THEMES = [
  {
    name: "Dark", type: "dark",
    ui: { bg: "#1e1e1e", bgAlt: "#252526", titlebar: "#323233", activity: "#333333", statusbar: "#007acc", fg: "#cccccc", fgDim: "#8a8a8a", fgBright: "#ffffff", accent: "#007acc", border: "#2b2b2b", borderLight: "#454545", hover: "#2a2d2e", selected: "#094771", tabActive: "#1e1e1e", tabInactive: "#2d2d2d", inputBg: "#3c3c3c", btnBg: "#3a3d41" },
    editor: { bg: "#1e1e1e", fg: "#d4d4d4", wordHl: "rgba(255,255,255,0.10)", bracket: "rgba(150,150,150,0.55)" },
    tokens: { keyword1: "#569cd6", keyword2: "#c586c0", keyword3: "#4fc1ff", number: "#b5cea8", string: "#ce9178", comment: "#6a9955", function: "#dcdcaa", type: "#4ec9b0", operator: "#d4d4d4" },
  },
  {
    name: "Dark High Contrast", type: "dark",
    ui: { bg: "#000000", bgAlt: "#0a0a0a", titlebar: "#000000", activity: "#000000", statusbar: "#000000", fg: "#ffffff", fgDim: "#cccccc", fgBright: "#ffffff", accent: "#f38518", border: "#6fc3df", borderLight: "#6fc3df", hover: "rgba(255,255,255,0.13)", selected: "#0f4a85", tabActive: "#000000", tabInactive: "#0a0a0a", inputBg: "#0a0a0a", btnBg: "#0a0a0a" },
    editor: { bg: "#000000", fg: "#ffffff", wordHl: "rgba(255,255,255,0.22)", bracket: "#6fc3df" },
    tokens: { keyword1: "#569cd6", keyword2: "#c586c0", keyword3: "#9cdcfe", number: "#b5cea8", string: "#ce9178", comment: "#7ca668", function: "#dcdcaa", type: "#4ec9b0", operator: "#ffffff" },
  },
  {
    name: "Light", type: "light",
    ui: { bg: "#ffffff", bgAlt: "#f3f3f3", titlebar: "#dddddd", activity: "#e8e8e8", statusbar: "#007acc", fg: "#333333", fgDim: "#616161", fgBright: "#000000", accent: "#007acc", border: "#e7e7e7", borderLight: "#c8c8c8", hover: "#e8e8e8", selected: "#cfe3fb", tabActive: "#ffffff", tabInactive: "#ececec", inputBg: "#ffffff", btnBg: "#e4e4e4" },
    editor: { bg: "#ffffff", fg: "#000000", wordHl: "rgba(0,0,0,0.08)", bracket: "rgba(0,0,0,0.40)" },
    tokens: { keyword1: "#0000ff", keyword2: "#af00db", keyword3: "#0070c1", number: "#098658", string: "#a31515", comment: "#008000", function: "#795e26", type: "#267f99", operator: "#000000" },
  },
  {
    name: "Light High Contrast", type: "light",
    ui: { bg: "#ffffff", bgAlt: "#ffffff", titlebar: "#ffffff", activity: "#ffffff", statusbar: "#0f4a85", fg: "#000000", fgDim: "#4a4a4a", fgBright: "#000000", accent: "#0f4a85", border: "#0f4a85", borderLight: "#0f4a85", hover: "rgba(0,0,0,0.07)", selected: "#add6ff", tabActive: "#ffffff", tabInactive: "#f0f0f0", inputBg: "#ffffff", btnBg: "#ffffff" },
    editor: { bg: "#ffffff", fg: "#000000", wordHl: "rgba(0,0,0,0.12)", bracket: "#0f4a85" },
    tokens: { keyword1: "#0000ff", keyword2: "#af00db", keyword3: "#0070c1", number: "#098658", string: "#a31515", comment: "#008000", function: "#795e26", type: "#267f99", operator: "#000000" },
  },
];

// ----- first-run welcome / onboarding -----
const WELCOME_KEY = "editor-ide:welcome-seen:v1";
function showWelcomeScreen(force) {
  if (!force && localStorage.getItem(WELCOME_KEY)) return;
  const existing = $("welcome-overlay");
  if (existing) existing.remove();
  const ov = document.createElement("div");
  ov.id = "welcome-overlay";
  ov.innerHTML = `
    <div class="welcome-modal">
      <h1>Welcome to Bi-Code</h1>
      <p class="muted">Pick a theme to get started — you can change it anytime from the Themes view.</p>
      <div class="welcome-themes"></div>
      <ul class="welcome-tips">
        <li><b>${escapeHtmlText(settings.commandPaletteKey)}</b> — Command Palette: run anything</li>
        <li><b>Ctrl+\`</b> Terminal · <b>Ctrl+F</b> Find/Replace (regex) · <b>Ctrl+D</b> multi-cursor</li>
        <li><b>Right-click</b> a symbol → look it up on MDN</li>
        <li>Left activity bar: Explorer · Search · Source Control · Commands · Themes</li>
        <li>Status bar: branch, <b>Go Live</b> server, ESP flash</li>
      </ul>
      <label class="welcome-skip"><input type="checkbox" id="welcome-dontshow"> Don't show this again</label>
      <div class="welcome-foot"><button class="primary-btn" id="welcome-start">Get Started</button></div>
    </div>`;
  document.body.appendChild(ov);
  const themesEl = ov.querySelector(".welcome-themes");
  for (const t of BUILTIN_THEMES) {
    const card = document.createElement("button");
    card.className = "welcome-theme-card";
    card.style.background = t.editor.bg;
    card.style.color = t.editor.fg;
    card.style.borderColor = t.ui.accent || "#888";
    card.innerHTML =
      `<span class="wtc-name">${t.name}</span>` +
      `<span class="wtc-sample"><b style="color:${t.tokens.keyword1}">const</b> <span style="color:${t.tokens.function}">f</span> = <span style="color:${t.tokens.string}">"hi"</span></span>`;
    card.onclick = () => {
      useTheme(t);
      themesEl.querySelectorAll(".welcome-theme-card").forEach((c) => c.classList.remove("sel"));
      card.classList.add("sel");
    };
    themesEl.appendChild(card);
  }
  ov.querySelector("#welcome-start").onclick = () => {
    if (ov.querySelector("#welcome-dontshow").checked) localStorage.setItem(WELCOME_KEY, "1");
    ov.remove();
  };
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) ov.remove(); });
}

async function resolveThemeInclude(theme, zip, themePath) {
  if (!theme.include) return theme;
  const dir = themePath.slice(0, themePath.lastIndexOf("/") + 1);
  const incPath = (dir + theme.include.replace(/^\.\//, "")).replace(/\/\//g, "/");
  const f = zip.file(incPath);
  if (!f) return theme;
  const base = parseThemeFile(await f.async("string"));
  return {
    ...base,
    ...theme,
    colors: { ...(base.colors || {}), ...(theme.colors || {}) },
    tokenColors: [...(base.tokenColors || []), ...(theme.tokenColors || [])],
  };
}

// Download a theme extension's .vsix and parse every color theme it contributes
// into our normalized format. Results are cached per extension id.
const _themeCache = new Map();
async function fetchExtensionThemes(ext) {
  const id = `${ext.namespace}.${ext.name}`;
  if (_themeCache.has(id)) return _themeCache.get(id);
  if (typeof JSZip === "undefined") throw "zip library failed to load";

  const meta = JSON.parse(await invoke("http_get_text", { url: `https://open-vsx.org/api/${ext.namespace}/${ext.name}/latest` }));
  const dl = meta.files && meta.files.download;
  if (!dl) throw "no download url";
  const zip = await JSZip.loadAsync(await invoke("http_get_base64", { url: dl }), { base64: true });

  const pkgFile = zip.file("extension/package.json") || (zip.file(/(^|\/)package\.json$/i) || [])[0];
  if (!pkgFile) throw "package.json not found";
  const pkg = parseThemeFile(await pkgFile.async("string"));
  const contributed = (pkg.contributes && pkg.contributes.themes) || [];

  const out = [];
  for (const c of contributed) {
    const themePath = ("extension/" + c.path.replace(/^\.\//, "")).replace(/\/\//g, "/");
    let tf = zip.file(themePath);
    if (!tf) {
      const base = c.path.split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      tf = (zip.file(new RegExp(base + "$")) || [])[0];
    }
    if (!tf) continue;
    let raw = parseThemeFile(await tf.async("string"));
    raw = await resolveThemeInclude(raw, zip, themePath);
    out.push({ label: c.label || c.id || ext.displayName, uiTheme: c.uiTheme || "", normalized: normalizeVscodeTheme(raw, c.label || ext.displayName || ext.name) });
  }
  _themeCache.set(id, out);
  return out;
}

// ----- installed/applied theme registry (for the quick pick) -----
// Installed extensions stay on the system (with their parsed themes) until
// removed — downloading does NOT apply anything. "Use" applies a theme,
// "Uninstall" removes the extension.
const EXTENSIONS_KEY = "editor-ide:extensions:v1";
const extId = (ext) => `${ext.namespace}.${ext.name}`;
function loadExtensions() {
  try { return JSON.parse(localStorage.getItem(EXTENSIONS_KEY) || "[]"); } catch (e) { return []; }
}
function saveExtensions(list) {
  try { localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
}
function findInstalled(id) { return loadExtensions().find((x) => x.id === id) || null; }

async function installExtension(ext) {
  const id = extId(ext);
  if (findInstalled(id)) return findInstalled(id);
  const themes = await fetchExtensionThemes(ext); // download + parse, no apply
  const record = {
    id,
    name: ext.displayName || ext.name,
    namespace: ext.namespace,
    extName: ext.name,
    icon: (ext.files && ext.files.icon) || "",
    themes,
  };
  const list = loadExtensions().filter((x) => x.id !== id);
  list.unshift(record);
  saveExtensions(list);
  toast("Downloaded " + record.name + " — not applied. Use it from its page.");
  return record;
}

function uninstallExtension(id) {
  const ext = findInstalled(id);
  saveExtensions(loadExtensions().filter((x) => x.id !== id));
  // if the currently active theme belongs to this extension, revert to default
  let reverted = false;
  if (ext) {
    try {
      const active = JSON.parse(localStorage.getItem(THEME_KEY) || "null");
      if (active && ext.themes.some((t) => t.normalized.name === active.name)) {
        resetTheme(); // clears the theme and toasts "reset to default"
        reverted = true;
      }
    } catch (e) { /* ignore */ }
  }
  if (!reverted) toast("Removed extension");
}

// Apply (use) a specific theme as the active one.
function useTheme(normalized) {
  applyTheme(normalized);
  saveTheme(normalized);
  toast("Using theme: " + normalized.name);
}

// ----- Extensions sidebar (dynamic theme search) -----
let extSearchTimer = null;
function onExtSearchInput() {
  clearTimeout(extSearchTimer);
  extSearchTimer = setTimeout(renderExtensions, 280);
}

function extRow({ icon, name, sub, onClick, actions }) {
  const row = document.createElement("div");
  row.className = "ext-row";
  const ico = document.createElement("div");
  ico.className = "ext-ico";
  if (icon) { const img = document.createElement("img"); img.src = icon; img.onerror = () => { ico.textContent = "🎨"; }; ico.appendChild(img); }
  else ico.textContent = "🎨";
  const meta = document.createElement("div");
  meta.className = "ext-meta";
  meta.innerHTML = `<div class="ext-name">${escapeHtmlText(name)}</div><div class="ext-pub">${escapeHtmlText(sub || "")}</div>`;
  row.append(ico, meta);
  if (actions) { const a = document.createElement("div"); a.className = "ext-actions"; actions.forEach((b) => a.appendChild(b)); row.appendChild(a); }
  if (onClick) { meta.style.cursor = "pointer"; ico.style.cursor = "pointer"; meta.onclick = onClick; ico.onclick = onClick; }
  return row;
}

async function renderExtensions() {
  const host = $("ext-results");
  const installed = loadExtensions();
  host.innerHTML = "";

  // Built-in themes (always present, cannot be removed)
  const bh = document.createElement("div");
  bh.className = "scm-section-title";
  bh.textContent = "Built-in";
  host.appendChild(bh);
  for (const t of BUILTIN_THEMES) {
    const use = document.createElement("button");
    use.className = "mini-btn";
    use.textContent = "Use";
    use.onclick = (e) => { e.stopPropagation(); useTheme(t); };
    host.appendChild(extRow({ icon: "", name: t.name, sub: `${t.type} · built-in`, actions: [use] }));
  }

  if (installed.length) {
    const h = document.createElement("div");
    h.className = "scm-section-title";
    h.textContent = "Installed";
    host.appendChild(h);
    for (const it of installed) {
      const del = document.createElement("button");
      del.className = "mini-btn";
      del.textContent = "Uninstall";
      del.onclick = (e) => { e.stopPropagation(); uninstallExtension(it.id); renderExtensions(); };
      host.appendChild(extRow({
        icon: it.icon, name: it.name,
        sub: `${it.namespace} · ${it.themes.length} theme${it.themes.length === 1 ? "" : "s"}`,
        onClick: () => openThemePage({ namespace: it.namespace, name: it.extName, displayName: it.name, files: { icon: it.icon } }),
        actions: [del],
      }));
      // every theme the extension contributes is selectable on its own
      for (const t of it.themes) {
        const row = document.createElement("div");
        row.className = "ext-subrow";
        const sw = document.createElement("span");
        sw.className = "ext-theme-sw";
        sw.style.background = t.normalized.editor?.bg || "#1e1e1e";
        sw.style.color = t.normalized.editor?.fg || "#ccc";
        sw.textContent = "Ab";
        const name = document.createElement("span");
        name.className = "ext-subrow-name";
        name.textContent = t.label;
        const use = document.createElement("button");
        use.className = "mini-btn";
        use.textContent = "Use";
        use.onclick = () => useTheme(t.normalized);
        row.append(sw, name, use);
        host.appendChild(row);
      }
    }
  }

  const q = $("ext-search").value.trim();
  const sh = document.createElement("div");
  sh.className = "scm-section-title";
  sh.textContent = q ? "Open VSX results" : "Popular themes";
  host.appendChild(sh);

  const loading = document.createElement("div");
  loading.className = "scm-empty";
  loading.textContent = "Searching…";
  host.appendChild(loading);

  try {
    const url = `https://open-vsx.org/api/-/search?query=${encodeURIComponent(q || "theme")}&category=Themes&size=40&sortBy=${q ? "relevance" : "downloadCount"}`;
    const data = JSON.parse(await invoke("http_get_text", { url }));
    loading.remove();
    // already-installed themes live in the "Installed" section above, so drop
    // them from the search results.
    const exts = (data.extensions || []).filter((ext) => !findInstalled(extId(ext)));
    if (!exts.length) { host.insertAdjacentHTML("beforeend", '<div class="scm-empty">No new themes found.</div>'); return; }
    for (const ext of exts) {
      const dl = document.createElement("button");
      dl.className = "mini-btn";
      dl.textContent = "Download";
      dl.onclick = async (e) => {
        e.stopPropagation();
        dl.textContent = "…"; dl.disabled = true;
        try { await installExtension(ext); renderExtensions(); } catch (err) { toast("Download failed: " + err, true); dl.textContent = "Download"; dl.disabled = false; }
      };
      host.appendChild(extRow({
        icon: ext.files && ext.files.icon,
        name: ext.displayName || ext.name,
        sub: `${ext.namespace}${ext.downloadCount ? " · ↓" + ext.downloadCount : ""}`,
        onClick: () => openThemePage(ext),
        actions: [dl],
      }));
    }
  } catch (e) {
    loading.textContent = "Search failed: " + e;
  }
}

// ----- theme page (opens as an editor tab) -----
function openThemePage(ext) {
  const path = `ext://${ext.namespace}.${ext.name}`;
  let tab = state.tabs.get(path);
  if (!tab) {
    tab = { path, name: ext.displayName || ext.name, kind: "extension", ext };
    state.tabs.set(path, tab);
    renderTabs();
  }
  activateTab(path);
}

function hideExtensionView() {
  const v = $("extension-view");
  if (v) v.hidden = true;
}

async function renderExtensionPage(tab) {
  const v = $("extension-view");
  v.hidden = false;
  const ext = tab.ext;
  const icon = ext.files && ext.files.icon;
  v.innerHTML = `
    <div class="ext-page">
      <div class="ext-page-head">
        <div class="ext-page-ico">${icon ? `<img src="${escapeHtmlText(icon)}" onerror="this.replaceWith(document.createTextNode('🎨'))">` : "🎨"}</div>
        <div class="ext-page-title">
          <h1>${escapeHtmlText(ext.displayName || ext.name)}</h1>
          <div class="ext-page-pub">${escapeHtmlText(ext.namespace)}${ext.downloadCount ? " · ↓ " + ext.downloadCount : ""}${ext.averageRating ? " · ★ " + ext.averageRating.toFixed(1) : ""}</div>
          <div class="ext-page-desc">${escapeHtmlText(ext.description || ext.shortDescription || "")}</div>
        </div>
      </div>
      <div class="ext-page-section">
        <h2>Color Themes</h2>
        <div id="ext-page-themes"><div class="scm-empty">Loading themes…</div></div>
      </div>
    </div>`;

  // header action button (Download / Uninstall) reflects install state
  const head = v.querySelector(".ext-page-title");
  const id = extId(ext);
  const actionBtn = document.createElement("button");
  actionBtn.className = "primary-btn";
  actionBtn.style.cssText = "width:auto; margin-top:10px; padding:6px 16px";
  head.appendChild(actionBtn);
  const refreshActionBtn = () => {
    if (findInstalled(id)) {
      actionBtn.textContent = "Uninstall";
      actionBtn.onclick = () => { uninstallExtension(id); refreshActionBtn(); renderExtensionPage(tab); };
    } else {
      actionBtn.textContent = "Download";
      actionBtn.onclick = async () => {
        actionBtn.textContent = "…"; actionBtn.disabled = true;
        try { await installExtension(ext); } catch (e) { toast("Download failed: " + e, true); }
        actionBtn.disabled = false; refreshActionBtn();
      };
    }
  };
  refreshActionBtn();

  const list = v.querySelector("#ext-page-themes");
  try {
    const themes = await fetchExtensionThemes(ext);
    if (state.active !== tab.path) return; // user navigated away
    list.innerHTML = "";
    if (!themes.length) { list.innerHTML = '<div class="scm-empty">This extension contributes no color themes.</div>'; return; }
    for (const t of themes) {
      const row = document.createElement("div");
      row.className = "ext-theme-row";
      const sw = document.createElement("span");
      sw.className = "ext-theme-sw";
      sw.style.background = t.normalized.editor?.bg || "#1e1e1e";
      sw.style.color = t.normalized.editor?.fg || "#ccc";
      sw.textContent = "Ab";
      const name = document.createElement("span");
      name.className = "ext-theme-name";
      name.textContent = t.label + (t.uiTheme ? `  (${t.uiTheme.replace("vs-", "").replace("vs", "light")})` : "");
      const useBtn = document.createElement("button");
      useBtn.className = "mini-btn";
      useBtn.textContent = "Use";
      useBtn.title = "Apply this theme";
      useBtn.onclick = () => useTheme(t.normalized);
      row.append(sw, name, useBtn);
      list.appendChild(row);
    }
  } catch (e) {
    if (state.active === tab.path) list.innerHTML = `<div class="scm-empty">Could not load themes: ${escapeHtmlText(e)}</div>`;
  }
}

// ----- "Select Color Theme" quick pick -----
function openThemeQuickPick() {
  const themes = BUILTIN_THEMES.map((t) => ({ label: t.name + "  (built-in)", theme: t }));
  for (const ext of loadExtensions()) {
    for (const t of ext.themes) themes.push({ label: t.label, theme: t.normalized });
  }
  const items = [{ label: "Browse themes…", browse: true }, ...themes];
  const ov = $("quickpick-overlay");
  const input = $("quickpick-input");
  const listEl = $("quickpick-list");
  let idx = 0;

  function draw(filter) {
    const f = (filter || "").toLowerCase();
    const shown = items.filter((it) => it.label.toLowerCase().includes(f));
    idx = 0;
    listEl.innerHTML = "";
    shown.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === 0 ? " active" : "");
      el.textContent = it.label;
      el.onmousedown = (e) => { e.preventDefault(); pick(it); };
      listEl.appendChild(el);
    });
    listEl._shown = shown;
  }
  function move(d) {
    const n = listEl.children.length;
    if (!n) return;
    idx = (idx + d + n) % n;
    [...listEl.children].forEach((c, i) => c.classList.toggle("active", i === idx));
    listEl.children[idx].scrollIntoView({ block: "nearest" });
  }
  function pick(it) {
    close();
    if (it.browse) { clickActAndFocus("extensions"); return; }
    if (it.theme) useTheme(it.theme);
  }
  function close() { ov.hidden = true; input.onkeydown = null; input.oninput = null; }

  input.value = "";
  draw("");
  input.oninput = () => draw(input.value);
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(listEl._shown[idx]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  ov.hidden = false;
  input.focus();
}

// ===========================================================================
// Debugging (Node via CDP, PHP/Web via run)
// ===========================================================================
const breakpoints = new Map(); // absolute path -> Set<number> (0-based lines)
let dbg = null;

function bpSet(path) { if (!breakpoints.has(path)) breakpoints.set(path, new Set()); return breakpoints.get(path); }
function toggleBreakpoint(path, line) {
  const s = bpSet(path);
  if (s.has(line)) s.delete(line); else s.add(line);
  if (!s.size) breakpoints.delete(path);
  if (state.active === path && editor) editor.setBreakpoints([...(breakpoints.get(path) || [])]);
  renderBreakpointsList();
  if (dbg && dbg.kind === "node") syncCdpBreakpoints();
}
function applyEditorBreakpoints() {
  const tab = state.active && state.tabs.get(state.active);
  if (editor && tab && !tab.kind) editor.setBreakpoints([...(breakpoints.get(state.active) || [])]);
}
function renderBreakpointsList() {
  const host = $("dbg-breakpoints");
  if (!host) return;
  host.innerHTML = "";
  let any = false;
  for (const [path, set] of breakpoints) {
    for (const ln of [...set].sort((a, b) => a - b)) {
      any = true;
      const row = document.createElement("div");
      row.className = "dbg-item";
      row.textContent = `${basename(path)}:${ln + 1}`;
      row.title = path;
      row.onclick = () => openFile(path).then(() => { if (editor) editor.setCursor({ line: ln, col: 0 }); });
      host.appendChild(row);
    }
  }
  if (!any) host.innerHTML = '<div class="scm-empty">No breakpoints.</div>';
}
function dbgLog(text, cls) {
  const el = $("dbg-console");
  if (!el) return;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function setDebugButtons(s) { // 'idle' | 'running' | 'paused'
  $("dbg-run").disabled = s !== "idle";
  $("dbg-stop").disabled = s === "idle";
  const step = s === "paused";
  ["dbg-continue", "dbg-stepover", "dbg-stepinto", "dbg-stepout"].forEach((id) => ($(id).disabled = !step));
}

// Generic command-palette-style quick pick (reuses the quickpick overlay).
function openQuickPick(items, onPick, placeholder) {
  const ov = $("quickpick-overlay");
  const input = $("quickpick-input");
  const listEl = $("quickpick-list");
  let idx = 0;
  let shown = items;
  input.placeholder = placeholder || "Select…";
  function draw(filter) {
    const f = (filter || "").toLowerCase();
    shown = items.filter((it) => it.label.toLowerCase().includes(f));
    idx = 0;
    listEl.innerHTML = "";
    shown.forEach((it, i) => {
      const el = document.createElement("div");
      el.className = "palette-item" + (i === 0 ? " active" : "");
      el.textContent = it.label;
      el.onmousedown = (e) => { e.preventDefault(); pick(it); };
      listEl.appendChild(el);
    });
  }
  function move(d) {
    const n = listEl.children.length;
    if (!n) return;
    idx = (idx + d + n) % n;
    [...listEl.children].forEach((c, i) => c.classList.toggle("active", i === idx));
    listEl.children[idx].scrollIntoView({ block: "nearest" });
  }
  function pick(it) { close(); if (it) onPick(it); }
  function close() { ov.hidden = true; input.onkeydown = null; input.oninput = null; }
  input.value = "";
  draw("");
  input.oninput = () => draw(input.value);
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); pick(shown[idx]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  ov.hidden = false;
  input.focus();
}

// Ask which configuration to launch (VSCode-style), then start it.
function pickAndRun() {
  openQuickPick(
    [
      { label: "▶  Node.js — current file (debug)", kind: "node" },
      { label: "▶  PHP — Live Server", kind: "php" },
      { label: "▶  Web — Live Server", kind: "web" },
    ],
    (it) => startDebug(it.kind),
    "Select a debug configuration"
  );
}

// Serve the open folder via Live Server and preview `relUrl` (or the root).
async function liveServe(relPath) {
  if (!state.root) { toast("Open a folder first.", true); return; }
  if (!liveServerPort) await toggleLiveServer(); // starts + opens preview at root
  if (liveServerPort) {
    const rel = relPath ? "/" + relPath.replace(/^\/+/, "") : "/";
    openPreviewTab(`http://localhost:${liveServerPort}${rel}`);
  }
}

async function startDebug(kind) {
  kind = kind || "node";
  if (dbg) await stopDebug();
  $("dbg-console").innerHTML = "";
  const tab = state.active && state.tabs.get(state.active);
  const file = tab && !tab.kind ? tab.path : null;
  const relOf = (p) => (state.root && p.startsWith(state.root) ? p.slice(state.root.length) : basename(p));

  if (kind === "web") {
    dbg = { kind: "web" };
    setDebugButtons("running");
    dbgLog("Web via Live Server…");
    await liveServe(file && /\.html?$/.test(file) ? relOf(file) : "");
    return;
  }
  if (kind === "php") {
    dbg = { kind: "php" };
    setDebugButtons("running");
    dbgLog("PHP via Live Server (php-cgi)…");
    await liveServe(file && file.endsWith(".php") ? relOf(file) : "");
    return;
  }
  // node — full run, stops only at breakpoints; stdout/stderr stream to console
  if (!file || !/\.(js|mjs|cjs)$/.test(file)) { toast("Open a .js file to debug.", true); return; }
  dbgLog("Running Node on " + basename(file) + "…");
  try { connectCdp(await invoke("dbg_node_start", { file, cwd: state.root || null })); }
  catch (e) { dbgLog("Error: " + e, "dbg-err"); endDebug(); }
}

function endDebug() { dbg = null; setDebugButtons("idle"); if (editor) editor.setDebugLine(null); }
async function stopDebug() {
  try { if (dbg && dbg.sock) dbg.sock.close(); } catch (e) {}
  try { await invoke("dbg_stop"); } catch (e) {}
  endDebug();
  $("dbg-callstack").innerHTML = "";
  $("dbg-vars").innerHTML = "";
  dbgLog("[stopped]");
}

// ----- CDP (Node) -----
function connectCdp(ws) {
  const sock = new WebSocket(ws);
  dbg = { kind: "node", sock, seq: 1, pending: new Map(), urlById: new Map(), bpIds: [] };
  sock.onmessage = onCdp;
  sock.onclose = () => { dbgLog("[session ended]"); endDebug(); };
  sock.onerror = () => dbgLog("[connection error]", "dbg-err");
  sock.onopen = async () => {
    setDebugButtons("running");
    try {
      await cdp("Runtime.enable");
      await cdp("Debugger.enable");
      await syncCdpBreakpoints();
      await cdp("Runtime.runIfWaitingForDebugger");
      dbgLog("Debugger attached.");
    } catch (e) { dbgLog("CDP error: " + (e.message || e), "dbg-err"); }
  };
}
function cdp(method, params) {
  return new Promise((res, rej) => {
    if (!dbg || !dbg.sock) { rej("no session"); return; }
    const id = dbg.seq++;
    dbg.pending.set(id, { res, rej });
    dbg.sock.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
function onCdp(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (msg.id != null) {
    const p = dbg.pending.get(msg.id);
    if (p) { dbg.pending.delete(msg.id); msg.error ? p.rej(msg.error) : p.res(msg.result); }
    return;
  }
  const m = msg.method, p = msg.params || {};
  if (m === "Debugger.scriptParsed") { if (p.url) dbg.urlById.set(p.scriptId, p.url); }
  else if (m === "Debugger.paused") onPaused(p);
  else if (m === "Debugger.resumed") { if (editor) editor.setDebugLine(null); setDebugButtons("running"); }
  // program stdout/stderr is streamed separately (dbg-out) to avoid duplicates
}
function cdpVal(o) {
  if (!o) return "";
  if (o.value !== undefined) return typeof o.value === "object" ? JSON.stringify(o.value) : String(o.value);
  return o.description || o.type || "";
}
async function syncCdpBreakpoints() {
  if (!dbg || dbg.kind !== "node") return;
  for (const id of dbg.bpIds || []) { try { await cdp("Debugger.removeBreakpoint", { breakpointId: id }); } catch (e) {} }
  dbg.bpIds = [];
  for (const [path, set] of breakpoints) {
    const url = "file://" + path;
    for (const ln of set) {
      try { const r = await cdp("Debugger.setBreakpointByUrl", { lineNumber: ln, url }); if (r && r.breakpointId) dbg.bpIds.push(r.breakpointId); } catch (e) {}
    }
  }
}
async function onPaused(p) {
  setDebugButtons("paused");
  const frames = p.callFrames || [];
  const cs = $("dbg-callstack");
  cs.innerHTML = "";
  frames.forEach((f, i) => {
    const url = f.url || dbg.urlById.get(f.location.scriptId) || "";
    const row = document.createElement("div");
    row.className = "dbg-item" + (i === 0 ? " active" : "");
    row.textContent = `${f.functionName || "(anonymous)"}  ${basename(url.replace(/^file:\/\//, ""))}:${f.location.lineNumber + 1}`;
    row.onclick = () => gotoFrame(f);
    cs.appendChild(row);
  });
  if (frames[0]) { gotoFrame(frames[0]); await showFrameVars(frames[0]); }
}
function gotoFrame(f) {
  const path = (f.url || dbg.urlById.get(f.location.scriptId) || "").replace(/^file:\/\//, "");
  if (!path) return;
  const line = f.location.lineNumber;
  openFile(path).then(() => { if (editor && state.active === path) editor.setDebugLine(line); });
}
async function showFrameVars(frame) {
  const host = $("dbg-vars");
  host.innerHTML = "";
  const local = (frame.scopeChain || []).find((s) => s.type === "local") || (frame.scopeChain || [])[0];
  if (!local || !local.object || !local.object.objectId) { host.innerHTML = '<div class="scm-empty">No variables.</div>'; return; }
  try {
    const r = await cdp("Runtime.getProperties", { objectId: local.object.objectId, ownProperties: true });
    const props = (r.result || []).filter((pr) => pr.value);
    for (const pr of props) {
      const row = document.createElement("div");
      row.className = "dbg-var";
      row.innerHTML = `<span class="dbg-var-name">${escapeHtmlText(pr.name)}</span><span class="dbg-var-val">${escapeHtmlText(cdpVal(pr.value))}</span>`;
      host.appendChild(row);
    }
    if (!props.length) host.innerHTML = '<div class="scm-empty">No local variables.</div>';
  } catch (e) {
    host.innerHTML = '<div class="scm-empty">' + escapeHtmlText(String(e.message || e)) + "</div>";
  }
}

function wireDebugEvents() {
  const listen = TAURI.event.listen;
  listen("dbg-out", (e) => dbgLog(e.payload.replace(/\n$/, "")));
  listen("dbg-exit", () => { dbgLog("[done]"); endDebug(); });
}

function renderDebugView() { renderBreakpointsList(); }

// ===========================================================================
// Wiring
// ===========================================================================
function init() {
  loadSettings();
  document.body.classList.toggle("no-tree-anim", !settings.treeAnimation);
  // load VSCode's Seti icon theme map (bundled locally; font via @font-face)
  fetch(SETI_THEME_URL)
    .then((r) => r.text())
    .then((t) => { if (setSetiTheme(t)) { renderTree(); renderTabs(); } })
    .catch(() => { /* local SVG fallback stays */ });
  loadStoredTheme();

  // window controls
  $("win-min").onclick = () => appWindow.minimize();
  $("win-max").onclick = () => appWindow.toggleMaximize();
  $("win-close").onclick = () => { persistSession(); appWindow.close(); };

  // open folder
  $("open-folder-btn").onclick = openFolder;
  $("welcome-open").onclick = openFolder;
  $("clone-repo-btn").onclick = cloneRepo;
  $("welcome-clone").onclick = cloneRepo;

  // command center (topbar) opens the command palette
  $("command-center").onclick = openPalette;
  updateCommandCenter();

  // sidebar actions
  $("new-file").onclick = () => state.root && newFile(targetDirFor(state.selected) || state.root);
  $("new-folder").onclick = () => state.root && newFolder(targetDirFor(state.selected) || state.root);
  $("refresh-tree").onclick = async () => {
    if (!state.root) return;
    for (const d of state.expanded) await refreshDir(d);
    renderTree();
  };
  $("collapse-tree").onclick = () => {
    if (!state.root) return;
    state.expanded = new Set([state.root]); // keep the root open, collapse the rest
    renderTree();
    saveSession();
  };

  // title-bar menus
  const MENUS = {
    file: showFileMenu,
    edit: showEditMenu,
    selection: showSelectionMenu,
    view: showViewMenu,
    terminal: showTerminalMenu,
    help: showHelpMenu,
  };
  $("menu").querySelectorAll(".menu-btn").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = !dropdown.hidden && dropdown._owner === b;
      hideMenus();
      if (!wasOpen) { dropdown._owner = b; MENUS[b.dataset.menu]?.(b); }
      else dropdown._owner = null;
    };
    // VSCode-like: once a menu is open, hovering another opens it
    b.onmouseenter = () => {
      if (!dropdown.hidden && dropdown._owner && dropdown._owner !== b) {
        hideMenus();
        dropdown._owner = b;
        MENUS[b.dataset.menu]?.(b);
      }
    };
  });

  // activity bar: explorer / search / scm switch panels, settings opens modal
  document.querySelectorAll(".act-btn").forEach((b) => {
    b.addEventListener("click", () => {
      const view = b.dataset.view;
      if (view === "settings") { openSettings(); return; }
      document.querySelectorAll(".act-btn").forEach((x) => x.classList.toggle("active", x === b));
      switchSidebar(view);
    });
  });

  // settings + source control + search + terminal panel controls
  wireSettingsControls();
  $("theme-select").onclick = () => { closeSettings(); openThemeQuickPick(); };
  $("theme-browse").onclick = () => { closeSettings(); clickActAndFocus("extensions"); };
  $("theme-reset").onclick = resetTheme;
  $("ext-search").addEventListener("input", onExtSearchInput);
  $("ssh-close").onclick = closeSshModal;
  $("ssh-connect-btn").onclick = sshConnect;
  $("ssh-overlay").addEventListener("mousedown", (e) => { if (e.target === $("ssh-overlay")) closeSshModal(); });
  $("quickpick-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("quickpick-overlay")) $("quickpick-overlay").hidden = true;
  });
  $("git-refresh").onclick = refreshGit;
  $("search-input").addEventListener("input", runSearch);
  $("search-case").onclick = () => { $("search-case").classList.toggle("active"); doSearch(); };
  $("term-new").onclick = () => newTerminal();
  $("term-hide").onclick = hideTerminalPanel;
  $("term-split").onclick = splitTerminal;
  $("term-kill").onclick = () => { if (activeTermId) closeTerminal(activeTermId); };
  $("term-max").onclick = toggleTerminalMax;
  // drag the active terminal name into the editor area to move it there
  $("term-active-name").addEventListener("dragstart", (e) => {
    if (activeTermId) e.dataTransfer.setData("application/x-bicode-term", activeTermId);
  });
  // editor tab strip accepts dropped terminals
  tabbarEl.addEventListener("dragover", (e) => {
    if ([...e.dataTransfer.types].includes("application/x-bicode-term")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
  });
  tabbarEl.addEventListener("drop", (e) => {
    const tid = e.dataTransfer.getData("application/x-bicode-term");
    if (tid) { e.preventDefault(); moveTerminalToEditor(tid); }
  });
  $("tasks-add").onclick = openTasks;
  // debug controls
  $("dbg-run").onclick = pickAndRun;
  $("dbg-stop").onclick = stopDebug;
  $("dbg-continue").onclick = () => cdp("Debugger.resume").catch(() => {});
  $("dbg-stepover").onclick = () => cdp("Debugger.stepOver").catch(() => {});
  $("dbg-stepinto").onclick = () => cdp("Debugger.stepInto").catch(() => {});
  $("dbg-stepout").onclick = () => cdp("Debugger.stepOut").catch(() => {});
  wireDebugEvents();
  wireEspEvents();
  window.addEventListener("resize", fitActiveTerm);

  // drag the terminal panel's top edge to resize it
  $("term-resize").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = $("terminal-panel").offsetHeight;
    const areaH = $("editor-area").offsetHeight;
    const mv = (ev) => {
      const h = Math.max(80, Math.min(startH - (ev.clientY - startY), areaH - 120));
      $("editor-area").style.setProperty("--term-h", h + "px");
      fitActiveTerm();
    };
    const up = () => { window.removeEventListener("mousemove", mv); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", mv);
    window.addEventListener("mouseup", up);
  });

  // editor right-click context menu (cut/copy/paste, find, MDN lookup)
  editorHost.addEventListener("contextmenu", showEditorContextMenu);

  // SVG preview ⇄ code toggle
  $("svg-toggle").onclick = () => {
    const tab = state.active && state.tabs.get(state.active);
    if (!tab || !tab.isSvg) return;
    if (tab.mode === "code" && editor) tab.content = editor.getContent(); // keep edits
    tab.mode = tab.mode === "preview" ? "code" : "preview";
    if (tab.mode === "preview") tab.dataUrl = "data:image/svg+xml;base64," + b64utf8(tab.content);
    activateTab(tab.path);
  };

  // preview tab toolbar
  $("preview-reload").onclick = () => { const f = $("preview-frame"); f.src = f.src; };
  $("preview-back").onclick = () => { try { $("preview-frame").contentWindow.history.back(); } catch (e) { /* cross-origin */ } };
  $("preview-external").onclick = () => { const u = $("preview-url").value; if (u) openExternal(u); };
  $("preview-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const f = $("preview-frame"); f.src = $("preview-url").value; }
  });

  // command palette
  const pInput = $("palette-input");
  pInput.addEventListener("input", () => renderPalette(pInput.value));
  pInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); movePalette(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); movePalette(-1); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  $("palette-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("palette-overlay")) closePalette();
  });

  // task manager
  $("tasks-close").onclick = closeTasks;
  $("task-add-btn").onclick = addTask;
  $("tasks-overlay").addEventListener("mousedown", (e) => {
    if (e.target === $("tasks-overlay")) closeTasks();
  });
  document.querySelectorAll(".task-scope-btn").forEach((b) =>
    b.addEventListener("click", () => { taskEditScope = b.dataset.scope; syncTaskScopeButtons(); })
  );

  // configurable command-palette shortcut capture
  const keyInput = $("palette-key-input");
  keyInput.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const chord = chordFromEvent(e);
    keyInput.value = chord;
    settings.commandPaletteKey = chord;
    saveSettings();
  });

  // dismiss menus
  document.addEventListener("click", (e) => {
    if (!ctxMenu.contains(e.target) && !dropdown.contains(e.target)) hideMenus();
  });
  window.addEventListener("blur", hideMenus);

  // global shortcuts
  window.addEventListener("keydown", (e) => {
    // configurable command palette shortcut
    if (matchChord(e, settings.commandPaletteKey)) {
      e.preventDefault();
      if ($("palette-overlay").hidden) openPalette();
      else closePalette();
      return;
    }
    // Ctrl+` toggles the integrated terminal
    if ((e.ctrlKey || e.metaKey) && (e.key === "`" || e.code === "Backquote")) {
      e.preventDefault();
      toggleTerminal();
      return;
    }

    // Editor multi-cursor / case shortcuts (only when a text editor is active)
    const ed = activeTextEditor();
    if (ed && (e.ctrlKey || e.metaKey)) {
      const kk = e.key.toLowerCase();
      if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); ed.addCursorBelow(); return; }
      if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); ed.addCursorAbove(); return; }
      if (!e.altKey && !e.shiftKey && kk === "d") { e.preventDefault(); ed.addNextOccurrence(); return; }
      if (!e.altKey && !e.shiftKey && kk === "l") { e.preventDefault(); ed.selectLine(); return; }
      if (e.shiftKey && kk === "u") { e.preventDefault(); ed.transformCase("upper"); return; }
      if (e.shiftKey && kk === "l") { e.preventDefault(); ed.transformCase("lower"); return; }
    }

    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    // The editor handles Ctrl+S itself when focused (via registerSaveHandler);
    // only handle it here as a fallback when focus is elsewhere.
    if (k === "s" && document.activeElement !== editor) { e.preventDefault(); saveActive(); }
    else if (k === "w") { e.preventDefault(); if (state.active) closeTab(state.active); }
    else if (k === "n") { e.preventDefault(); if (state.root) newFile(targetDirFor(state.selected) || state.root); }
    else if (k === "k") { e.preventDefault(); openFolder(); }
    else if (k === "f" && e.shiftKey) { e.preventDefault(); document.querySelector('.act-btn[data-view="search"]').click(); }
  });

  // warn on close with unsaved changes, and snapshot the session
  window.addEventListener("beforeunload", (e) => {
    persistSession();
    if ([...state.tabs.values()].some((t) => t.dirty)) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // reflect persisted settings in the UI
  updateEspStatus();

  // Reopen the previous session if there is one; otherwise show the welcome.
  showWelcome();
  restoreSession().then((restored) => {
    if (!restored) showWelcome();
    updateLiveStatus();
  });

  // First-run onboarding (theme picker + tips), skippable.
  showWelcomeScreen(false);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
