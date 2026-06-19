// Real tree-sitter highlighter. The grammar runtime and per-language WASM
// grammars are loaded lazily from a CDN, so the editor stays usable while
// the network fetch is in flight (the renderer just falls back to plain
// escaped text until the language is ready).
//
// In web-tree-sitter 0.25 `node.startIndex`/`endIndex` are JS string
// (UTF-16) code-unit offsets — verified empirically against em-dash
// content — so we index into the source string directly rather than
// re-encoding to UTF-8 bytes.

import { LANGUAGES, TREE_SITTER_BASE, normalizeLanguage } from "./languages.js";

let tsModule = null;
let initPromise = null;

async function initTreeSitter() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    tsModule = await import(`${TREE_SITTER_BASE}/+esm`);
    await tsModule.Parser.init({
      locateFile: (file) => `${TREE_SITTER_BASE}/${file}`,
    });
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
}

const langCache = new Map();
const langPromises = new Map();
const parserCache = new Map();

export function loadLanguage(key) {
  const normalized = normalizeLanguage(key);
  if (!normalized) return Promise.resolve(null);
  if (langCache.has(normalized)) return Promise.resolve(langCache.get(normalized));
  if (langPromises.has(normalized)) return langPromises.get(normalized);

  const config = LANGUAGES[normalized];
  const promise = (async () => {
    try {
      await initTreeSitter();
      const language = await tsModule.Language.load(config.wasm);
      // Append a universal ERROR capture so syntax mistakes (which tree-sitter
      // represents with an ERROR subtree) get a visual marker on every grammar
      // without having to remember it in each language config. Languages whose
      // grammar over-reports ERROR nodes (e.g. HTML) opt out via errors:false.
      const errorCapture = config.errors === false ? "" : "\n(ERROR) @error\n";
      const compile = (highlights) =>
        new tsModule.Query(language, `${highlights}${errorCapture}`);
      let query = null;
      try {
        query = compile(config.highlights);
      } catch (err) {
        // A single unknown node type rejects the whole query. Fall back to a
        // minimal query the grammar is sure to accept (used by grammars whose
        // exact node names we can't pin down, e.g. SQL across dialects).
        console.warn(`[code-editor] highlight query failed for ${normalized}, trying fallback:`, err);
        if (config.fallbackHighlights) {
          try {
            query = compile(config.fallbackHighlights);
          } catch (err2) {
            console.error(`[code-editor] fallback highlight query failed for ${normalized}:`, err2);
          }
        }
      }
      // Compile injection queries (which run against THIS grammar's tree to
      // locate embedded regions). The embedded grammar itself is loaded
      // separately via injectionLanguages() — here we only need the locator.
      const injections = [];
      for (const inj of config.injections || []) {
        const target = normalizeLanguage(inj.lang);
        if (!target) continue;
        try {
          injections.push({ lang: target, query: new tsModule.Query(language, inj.query) });
        } catch (err) {
          console.error(`[code-editor] injection query failed for ${normalized}:`, err);
        }
      }
      const entry = { language, query, injections };
      langCache.set(normalized, entry);
      return entry;
    } catch (err) {
      console.error(`[code-editor] failed to load language ${normalized}:`, err);
      langPromises.delete(normalized);
      return null;
    }
  })();

  langPromises.set(normalized, promise);
  return promise;
}

export function isLanguageReady(key) {
  const normalized = normalizeLanguage(key);
  return normalized != null && langCache.has(normalized);
}

function getParser(key) {
  let parser = parserCache.get(key);
  if (parser) return parser;
  parser = new tsModule.Parser();
  parser.setLanguage(langCache.get(key).language);
  parserCache.set(key, parser);
  return parser;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function plainLines(lines) {
  return lines.map((line) => escapeHtml(line) || "&nbsp;");
}

// Single-slot cache: re-renders triggered by cursor movement keep the same
// text and the same language, so we can skip the parse entirely. Edits
// change `text`, invalidating the entry naturally.
let cache = { text: null, langKey: null, result: null };

export function highlightLines(lines, langKey) {
  const normalized = normalizeLanguage(langKey);
  if (!normalized) return plainLines(lines);

  const entry = langCache.get(normalized);
  if (!entry || !entry.query) return plainLines(lines);

  const text = lines.join("\n");
  // Which embedded grammars are loaded affects the output, so fold their
  // readiness into the cache key — otherwise a late-arriving injection grammar
  // would be masked by a stale cache entry for the same text.
  const injSig = (entry.injections || [])
    .map((inj) => (langCache.has(inj.lang) ? inj.lang[0] : "-"))
    .join("");
  if (cache.text === text && cache.langKey === normalized && cache.injSig === injSig) {
    return cache.result;
  }
  const N = text.length;

  const parser = getParser(normalized);
  const tree = parser.parse(text);
  const captures = entry.query.captures(tree.rootNode);

  // Errors are tracked separately so they layer on top of regular colors — an
  // identifier inside an ERROR subtree should keep its keyword color AND get
  // an error underline, not pick one or the other.
  const classes = new Array(N).fill(null);
  const errs = new Uint8Array(N);
  const regular = [];
  for (const cap of captures) {
    if (cap.name === "error") {
      const end = Math.min(cap.node.endIndex, N);
      for (let i = cap.node.startIndex; i < end; i++) errs[i] = 1;
    } else {
      regular.push(cap);
    }
  }

  // Smaller (more specific) captures win over larger enclosing ones, so we
  // paint the largest first and let inner ones overwrite their slice.
  regular.sort((a, b) =>
    (b.node.endIndex - b.node.startIndex) -
    (a.node.endIndex - a.node.startIndex)
  );
  for (const cap of regular) {
    const end = Math.min(cap.node.endIndex, N);
    for (let i = cap.node.startIndex; i < end; i++) classes[i] = cap.name;
  }

  // Embedded languages: locate each injected region in this tree, reparse its
  // text with the target grammar, and overwrite the host's classes there. Only
  // grammars already loaded participate; others colour in on a later render.
  for (const inj of entry.injections || []) {
    const sub = langCache.get(inj.lang);
    if (!sub || !sub.query) continue;
    const subParser = getParser(inj.lang);
    for (const region of inj.query.captures(tree.rootNode)) {
      const base = region.node.startIndex;
      const regionEnd = Math.min(region.node.endIndex, N);
      if (regionEnd <= base) continue;
      const subText = text.slice(base, regionEnd);
      const subTree = subParser.parse(subText);
      const subCaps = sub.query
        .captures(subTree.rootNode)
        .filter((c) => c.name !== "error");
      subCaps.sort((a, b) =>
        (b.node.endIndex - b.node.startIndex) - (a.node.endIndex - a.node.startIndex)
      );
      for (const sc of subCaps) {
        const start = base + sc.node.startIndex;
        const end = base + Math.min(sc.node.endIndex, subText.length);
        for (let i = start; i < end; i++) classes[i] = sc.name;
      }
      subTree.delete();
    }
  }

  const result = [];
  let lineHtml = "";
  let runStart = 0;
  let runClass = N > 0 ? classes[0] : null;
  let runErr   = N > 0 && errs[0] === 1;

  function flush(end) {
    if (end <= runStart) return;
    const slice = escapeHtml(text.slice(runStart, end));
    let cls = runClass;
    if (runErr) cls = cls ? `${cls} error` : "error";
    lineHtml += cls ? `<span class="${cls}">${slice}</span>` : slice;
  }

  for (let i = 0; i < N; i++) {
    if (text.charCodeAt(i) === 10) {
      flush(i);
      result.push(lineHtml || "&nbsp;");
      lineHtml = "";
      runStart = i + 1;
      runClass = i + 1 < N ? classes[i + 1] : null;
      runErr   = i + 1 < N && errs[i + 1] === 1;
    } else if (classes[i] !== runClass || (errs[i] === 1) !== runErr) {
      flush(i);
      runStart = i;
      runClass = classes[i];
      runErr   = errs[i] === 1;
    }
  }
  flush(N);
  result.push(lineHtml || "&nbsp;");

  tree.delete();
  cache = { text, langKey: normalized, injSig, result };
  return result;
}
