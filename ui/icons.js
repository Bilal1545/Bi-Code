// File icons use VSCode's built-in "Seti" icon theme from the microsoft/vscode
// repo (bundled under ui/icons/seti/): an icon FONT (seti.woff) + an
// extension→glyph/color map (vs-seti-icon-theme.json). Until the map loads,
// a tiny inline document glyph is shown.

export const SETI_THEME_URL = "icons/seti/vs-seti-icon-theme.json";

// Seti maps many types via VSCode languageId rather than extension.
const EXT_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  ts: "typescript", tsx: "typescriptreact", html: "html", htm: "html", css: "css",
  scss: "scss", sass: "sass", less: "less", py: "python", rb: "ruby", rs: "rust",
  go: "go", java: "java", kt: "kotlin", c: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
  swift: "swift", php: "php", lua: "lua", sh: "shellscript", bash: "shellscript",
  zsh: "shellscript", sql: "sql", md: "markdown", markdown: "markdown",
  yaml: "yaml", yml: "yaml", xml: "xml", vue: "vue",
  gitignore: "ignore", dockerignore: "ignore", npmignore: "ignore", eslintignore: "ignore",
};

let seti = null; // { extMap, nameMap, langMap, def }

// neutral inline document, shown before the Seti map is loaded
const FALLBACK =
  '<svg class="file-ic" viewBox="0 0 16 16" width="16" height="16" fill="none">' +
  '<path d="M4 1.75h5.4L13 5.3V13.4a.85.85 0 0 1-.85.85H4a.85.85 0 0 1-.85-.85V2.6A.85.85 0 0 1 4 1.75Z" fill="none" stroke="#9aa3ad" stroke-width="1"/>' +
  '<path d="M9.3 1.95v2.95a.6.6 0 0 0 .6.6h2.95" stroke="#9aa3ad" stroke-width="1"/></svg>';

export function setSetiTheme(jsonText) {
  try {
    const t = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
    const defs = t.iconDefinitions || {};
    const get = (key) => {
      const d = defs[key];
      if (!d) return null;
      let char = "";
      if (d.fontCharacter) {
        const cp = parseInt(d.fontCharacter.replace(/[\\uU]/g, ""), 16);
        if (cp) char = String.fromCodePoint(cp);
      }
      return { char, color: d.fontColor || "#cfd2d6" };
    };
    const extMap = {};
    for (const [k, v] of Object.entries(t.fileExtensions || {})) { const g = get(v); if (g) extMap[k.toLowerCase()] = g; }
    const nameMap = {};
    for (const [k, v] of Object.entries(t.fileNames || {})) { const g = get(v); if (g) nameMap[k.toLowerCase()] = g; }
    const langMap = {};
    for (const [k, v] of Object.entries(t.languageIds || {})) { const g = get(v); if (g) langMap[k] = g; }
    seti = { extMap, nameMap, langMap, def: get(t.file) };
    return true;
  } catch (e) {
    return false;
  }
}

const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

export function fileIconSvg(name) {
  if (!seti) return FALLBACK;
  const ext = extOf(name);
  const g =
    seti.nameMap[name.toLowerCase()] ||
    seti.extMap[ext] ||
    (EXT_LANG[ext] && seti.langMap[EXT_LANG[ext]]) ||
    seti.def;
  if (g && g.char) return `<span class="seti-ic" style="color:${g.color}">${g.char}</span>`;
  return FALLBACK;
}

// folders use the tree chevron, not a file icon
export function folderIconSvg() {
  return "";
}
