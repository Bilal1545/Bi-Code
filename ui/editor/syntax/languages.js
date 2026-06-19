// Tree-sitter language registry. Each entry maps a language key to its
// prebuilt grammar WASM and a highlight query in tree-sitter's S-expression
// format. Capture names map directly to CSS classes, so adding a class to
// code-editor.js is enough to surface a new capture.

// The tree-sitter runtime and grammars are vendored under
// ui/vendor/tree-sitter (pinned: web-tree-sitter 0.25.10,
// tree-sitter-wasms 0.1.13) so highlighting works offline and without a CDN —
// WebView2 on Windows failed to load them remotely. Resolved from this
// module's URL so the absolute URLs work inside web-tree-sitter's fetch().
const VENDOR = new URL("../../vendor/tree-sitter", import.meta.url).href;

export const TREE_SITTER_BASE = VENDOR;
const WASMS_BASE = `${VENDOR}/grammars`;

const javascript = {
  wasm: `${WASMS_BASE}/tree-sitter-javascript.wasm`,
  highlights: `
    [
      "var" "let" "const" "function" "class" "extends" "new"
      "typeof" "instanceof" "in" "of" "delete" "void" "static"
    ] @keyword1

    [
      "if" "else" "for" "while" "do" "switch" "case" "default"
      "break" "continue" "return" "throw" "try" "catch" "finally"
      "await" "async" "import" "export" "from" "as" "yield"
    ] @keyword2

    [(this) (super) (true) (false) (null)] @keyword3

    (number) @number
    (string) @string
    (template_string) @string
    (regex) @string
    (comment) @comment

    (function_declaration name: (identifier) @function)
    (method_definition  name: (property_identifier) @function)
    (call_expression    function: (identifier) @function)
    (call_expression    function: (member_expression
                                    property: (property_identifier) @function))

    (class_declaration  name: (identifier) @type)
    (new_expression     constructor: (identifier) @type)
  `,
};

const python = {
  wasm: `${WASMS_BASE}/tree-sitter-python.wasm`,
  highlights: `
    [
      "def" "class" "import" "from" "as" "with"
      "lambda" "global" "nonlocal" "pass"
    ] @keyword1

    [
      "if" "elif" "else" "for" "while"
      "try" "except" "finally" "raise"
      "break" "continue" "return" "yield" "async" "await"
    ] @keyword2

    [(true) (false) (none)] @keyword3

    (integer) @number
    (float) @number
    (string) @string
    (comment) @comment

    (function_definition name: (identifier) @function)
    (call function: (identifier) @function)
    (call function: (attribute attribute: (identifier) @function))

    (class_definition name: (identifier) @type)
  `,
};

const rust = {
  wasm: `${WASMS_BASE}/tree-sitter-rust.wasm`,
  highlights: `
    [
      "let" "const" "fn" "struct" "enum" "mod" "trait" "impl"
      "pub" "use" "crate" "mut" "ref" "static" "type" "where"
      "as" "in" "extern" "dyn" "move"
    ] @keyword1

    [
      "if" "else" "for" "while" "loop" "match"
      "break" "continue" "return"
    ] @keyword2

    (boolean_literal) @keyword3
    "self" @keyword3

    (integer_literal) @number
    (float_literal) @number
    (string_literal) @string
    (char_literal) @string
    (raw_string_literal) @string
    (line_comment) @comment
    (block_comment) @comment

    (function_item name: (identifier) @function)
    (call_expression function: (identifier) @function)

    (type_identifier) @type
    (primitive_type) @type
  `,
};

const go = {
  wasm: `${WASMS_BASE}/tree-sitter-go.wasm`,
  highlights: `
    [
      "var" "const" "type" "func" "struct" "interface"
      "package" "import" "map" "chan"
    ] @keyword1

    [
      "if" "else" "for" "switch" "case" "default"
      "break" "continue" "return" "defer" "go" "range" "select"
      "fallthrough" "goto"
    ] @keyword2

    [(true) (false) (nil) (iota)] @keyword3

    (int_literal) @number
    (float_literal) @number
    (interpreted_string_literal) @string
    (raw_string_literal) @string
    (rune_literal) @string
    (comment) @comment

    (function_declaration name: (identifier) @function)
    (method_declaration   name: (field_identifier) @function)
    (call_expression      function: (identifier) @function)

    (type_identifier) @type
  `,
};

const html = {
  wasm: `${WASMS_BASE}/tree-sitter-html.wasm`,
  // The HTML grammar emits ERROR nodes for plenty of perfectly valid markup
  // (text runs, custom elements, etc.), so the universal error squiggle is a
  // constant false positive here — disable it for HTML only.
  errors: false,
  highlights: `
    (tag_name) @keyword1
    (attribute_name) @keyword3
    (quoted_attribute_value) @string
    (comment) @comment
  `,
  // Embedded languages: the text inside <script>/<style> is reparsed with the
  // JS/CSS grammar and its colours layered over the HTML region. SVG and other
  // inline markup are plain elements, so they already colour as HTML tags.
  injections: [
    { lang: "javascript", query: `(script_element (raw_text) @content)` },
    { lang: "css", query: `(style_element (raw_text) @content)` },
  ],
};

const css = {
  wasm: `${WASMS_BASE}/tree-sitter-css.wasm`,
  highlights: `
    (property_name) @keyword1
    (class_selector) @keyword2
    (id_selector) @keyword2
    (tag_name) @keyword3
    (string_value) @string
    (integer_value) @number
    (float_value) @number
    (comment) @comment
  `,
};

const json = {
  wasm: `${WASMS_BASE}/tree-sitter-json.wasm`,
  highlights: `
    (pair key: (string) @keyword1)
    (string) @string
    (number) @number
    [(true) (false) (null)] @keyword3
    (comment) @comment
  `,
};

const sql = {
  wasm: `${WASMS_BASE}/tree-sitter-sql.wasm`,
  highlights: `
    [
      "select" "from" "where" "insert" "into" "values" "update" "set"
      "delete" "create" "table" "drop" "alter" "add" "column" "index"
      "view" "primary" "key" "foreign" "references" "default" "constraint"
      "unique" "not" "null" "as" "distinct" "into"
    ] @keyword1

    [
      "join" "inner" "left" "right" "outer" "full" "cross" "on" "using"
      "group" "by" "order" "having" "limit" "offset" "union" "all"
      "and" "or" "in" "between" "like" "is" "exists" "case" "when"
      "then" "else" "end" "asc" "desc" "with"
    ] @keyword2

    [(keyword_true) (keyword_false) (keyword_null)] @keyword3

    (literal) @string
    (comment) @comment

    (function_call function: (identifier) @function)
    (object_reference name: (identifier) @type)
    (column_definition name: (identifier) @keyword3)
  `,
  // Minimal query every SQL dialect grammar accepts, used if the rich query
  // above references a node type this particular grammar build doesn't expose.
  fallbackHighlights: `
    (literal) @string
    (comment) @comment
  `,
};

export const LANGUAGES = {
  javascript,
  python,
  rust,
  go,
  html,
  css,
  json,
  sql,
};

const ALIASES = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "javascript", tsx: "javascript", jsx: "javascript",
  typescript: "javascript",
  py: "python",
  rs: "rust",
  golang: "go",
  htm: "html",
  svg: "html",
  xml: "html",
  scss: "css",
};

const EXT_TO_LANG = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "javascript", jsx: "javascript", tsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  html: "html", htm: "html", svg: "html", xml: "html",
  css: "css", scss: "css",
  json: "json",
  sql: "sql",
};

export function normalizeLanguage(key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  if (LANGUAGES[k]) return k;
  if (ALIASES[k])   return ALIASES[k];
  return null;
}

// Languages embedded inside another (e.g. css/javascript inside html). The
// editor preloads these so injected regions can be highlighted synchronously.
export function injectionLanguages(key) {
  const normalized = normalizeLanguage(key);
  if (!normalized) return [];
  const injections = LANGUAGES[normalized].injections;
  if (!injections) return [];
  return injections.map((i) => normalizeLanguage(i.lang)).filter(Boolean);
}

// Pull the literal keywords out of a language's highlight query. Keywords are
// written as quoted tokens (e.g. "const" "let") in the S-expression source, so
// a single regex over the highlights string yields the keyword set without
// having to maintain a separate list per language.
const keywordCache = new Map();

export function languageKeywords(key) {
  const normalized = normalizeLanguage(key);
  if (!normalized) return [];
  if (keywordCache.has(normalized)) return keywordCache.get(normalized);

  const src = LANGUAGES[normalized].highlights;
  const words = new Set();
  for (const m of src.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) {
    words.add(m[1]);
  }
  const list = [...words].sort();
  keywordCache.set(normalized, list);
  return list;
}

export function detectLanguage(filename) {
  if (!filename) return null;
  const ext = filename.split(".").pop().toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}
