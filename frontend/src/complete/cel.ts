/**
 * CEL filter helpers, pure: completion context and candidates for the
 * filter field, and building a filter from a line of an object's YAML.
 */
import type { Candidate } from "./complete";
import type { FieldKeys } from "../transport/types";

/** What the caret is completing in a CEL draft. */
export interface CelContext {
  /** Start of the word being completed (replaced on accept). */
  from: number;
  /** The word typed so far (after the last dot, or a bare identifier). */
  word: string;
  /**
   * Object path the word is a key of ("" = top level of `o`), or undefined
   * when the word isn't a field of `o` (a function, a macro variable …).
   */
  path?: string;
}

const ident = /[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The completion context at the caret: `o.status.co|` → path "status",
 * word "co". A chain through an `exists(c, c.|)` variable isn't followed
 * (its element type is the list's: the path is the list's own path).
 */
export function celContext(src: string, caret: number): CelContext | undefined {
  const before = src.slice(0, caret);
  // inside a string literal: nothing to complete
  if ((before.match(/"/g)?.length ?? 0) % 2 === 1) return undefined;
  const word = before.match(ident)?.[0] ?? "";
  const from = caret - word.length;
  if (before[from - 1] !== ".") return { from, word };
  // walk back over a dot chain: o.a.b. (index [0] steps are skipped)
  const chain = before.slice(0, from - 1).match(/([A-Za-z_][A-Za-z0-9_]*)((?:\[\d+\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\])?)*)$/);
  if (!chain) return { from, word };
  const [, root, rest] = chain;
  const segs = rest!.split(".").filter(Boolean).map((s) => s.replace(/\[\d+\]$/, ""));
  if (root === "o") return { from, word, path: segs.join(".") };
  // a macro variable: `o.spec.containers.exists(c, c.ima|)` → spec.containers
  const bound = macroVar(before.slice(0, from - 1 - (chain[0]!.length)), root!);
  if (bound !== undefined) return { from, word, path: [bound, ...segs].filter(Boolean).join(".") };
  return { from, word };
}

/** Path of the list a macro variable ranges over: `o.x.y.exists(v,` → "x.y". */
function macroVar(before: string, name: string): string | undefined {
  const re = new RegExp(String.raw`o((?:\.[A-Za-z_][A-Za-z0-9_]*)+)\.(?:exists|all|exists_one|map|filter)\(\s*${name}\s*,`, "g");
  let last: string | undefined;
  for (const m of before.matchAll(re)) last = m[1]!.slice(1);
  return last;
}

/** Field key candidates; the detail shows the type and how many objects have the key. */
export function fieldCandidates(f: FieldKeys): Candidate[] {
  return f.keys.map((k) => ({ value: k.key, label: k.key, detail: `${k.type} · ${k.count}/${f.objects}` }));
}

/** CEL macros and functions worth offering after a dot or as a bare word. */
export const celFunctions: Candidate[] = [
  { value: "exists(x, ", label: "exists(x, …)", detail: "any element matches" },
  { value: "all(x, ", label: "all(x, …)", detail: "every element matches" },
  { value: "exists_one(x, ", label: "exists_one(x, …)", detail: "exactly one matches" },
  { value: "map(x, ", label: "map(x, …)", detail: "transform elements" },
  { value: "filter(x, ", label: "filter(x, …)", detail: "keep matching elements" },
  { value: "size()", label: "size()", detail: "length" },
  { value: "startsWith(", label: "startsWith(…)", detail: "string prefix" },
  { value: "endsWith(", label: "endsWith(…)", detail: "string suffix" },
  { value: "contains(", label: "contains(…)", detail: "substring" },
  { value: "matches(", label: "matches(…)", detail: "regex (RE2)" },
  { value: "lowerAscii()", label: "lowerAscii()", detail: "lower case" },
  { value: "split(", label: "split(…)", detail: "string → list" },
  { value: "sum()", label: "sum()", detail: "list of numbers" },
  { value: "orValue(", label: "orValue(…)", detail: "default for o.?a.?b" },
];

/** Bare-word candidates (start of an expression or after an operator). */
export const celGlobals: Candidate[] = [
  { value: "o.", label: "o", detail: "the object" },
  { value: "has(", label: "has(o.…)", detail: "field is set" },
  { value: "size(", label: "size(…)", detail: "length" },
  { value: "int(", label: "int(…)", detail: "convert" },
  { value: "string(", label: "string(…)", detail: "convert" },
  { value: "timestamp(", label: "timestamp(…)", detail: "RFC 3339 → time" },
];

/** One step of a YAML path: a map key, or a list item (index). */
export type Step = { key: string } | { index: number };

/** Field path and scalar value of one YAML line, as produced by sigs.k8s.io/yaml. */
export interface YamlLeaf {
  path: Step[];
  /** The parsed scalar; undefined if the line has no scalar (a map or list starts). */
  value?: string | number | boolean | null;
}

/**
 * Resolves the field path and value of one line of block YAML as Go
 * marshals it (sigs.k8s.io/yaml: 2-space maps, list items "- " at the
 * parent key's indent, no flow style except {} / [], no anchors). Scans
 * from the top keeping a stack of open containers. Pure.
 */
export function yamlLeaf(lines: string[], line: number): YamlLeaf | undefined {
  if (!lines[line]?.trim() || lines[line]!.trim().startsWith("#")) return undefined;
  // open containers: map children start at `col`; a list under a key starts at the key's own column (`itemCol`)
  type Frame = { col: number; itemCol: number; path: Step[] };
  const stack: Frame[] = [{ col: 0, itemCol: 0, path: [] }];
  let leaf: YamlLeaf | undefined;
  // inside a block scalar (key: | or >): lines deeper than its key are text, not fields
  let block = -1;
  for (let i = 0; i <= line; i++) {
    const raw = lines[i]!;
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    let col = raw.length - raw.trimStart().length;
    if (block >= 0 && col > block) {
      if (i === line) return undefined;
      continue;
    }
    block = -1;
    let rest = raw.slice(col);
    const item = rest.startsWith("- ") || rest === "-";
    while (stack.length > 1) {
      const top = stack[stack.length - 1]!;
      if (col >= (item ? top.itemCol : top.col)) break;
      stack.pop();
    }
    let path = stack[stack.length - 1]!.path;
    // each "- " opens a list item whose map starts 2 columns further
    while (rest.startsWith("- ") || rest === "-") {
      path = [...path, { index: -1 }];
      col += 2;
      rest = rest.slice(2);
      stack.push({ col, itemCol: col, path });
    }
    const kv = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:'"\s][^:]*?):(?: (.*))?$/);
    if (kv) {
      const keyPath = [...path, { key: unquoteKey(kv[1]!) }];
      const v = kv[2];
      // a nested map (entries at col + 2) or list (items at col) follows
      if (v === undefined || v === "") stack.push({ col: col + 2, itemCol: col, path: keyPath });
      else if (/^[|>]/.test(v)) block = col;
      if (i === line) {
        leaf = { path: keyPath };
        if (v !== undefined && v !== "" && !/^[|>]/.test(v) && v !== "{}" && v !== "[]") leaf.value = scalar(v);
      }
    } else if (i === line) {
      // a scalar list item: "- --a"
      leaf = { path };
      if (rest && !/^[|>]/.test(rest)) leaf.value = scalar(rest);
    }
  }
  return leaf;
}

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return JSON.parse(k) as string;
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

function scalar(s: string): string | number | boolean | null {
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s;
    }
  }
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  return s;
}

const reserved = new Set(["in", "as", "break", "const", "continue", "else", "for", "function", "if", "import", "let", "loop", "package", "namespace", "return", "var", "void", "while", "true", "false", "null"]);

/** `.name`, or `["name"]` where CEL syntax needs it (dots, slashes, reserved words). */
function access(key: string, optional: boolean): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !reserved.has(key);
  if (plain) return optional ? `.?${key}` : `.${key}`;
  return optional ? `[?${JSON.stringify(key)}]` : `[${JSON.stringify(key)}]`;
}

function literal(v: string | number | boolean | null): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/**
 * A filter expression for `path == value` (or `!=`). List steps become
 * exists(): `spec.containers[].image == x` → any container has that image.
 * `!=` means "objects that don't have this": also those where the field is
 * missing, so it's built from optionals instead of a plain `!=` (which a
 * missing field would turn into no-match).
 */
export function celFromLeaf(leaf: YamlLeaf, op: "==" | "!="): string | undefined {
  if (leaf.value === undefined || !leaf.path.length) return undefined;
  const vars = ["x", "y", "z", "w"];
  const build = (steps: Step[], root: string, depth: number, neg: boolean): string => {
    let expr = root;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if ("index" in s) {
        const v = vars[depth] ?? `v${depth}`;
        const inner = build(steps.slice(i + 1), v, depth + 1, false);
        return neg ? `!${expr}.orValue([]).exists(${v}, ${inner})` : `${expr}.exists(${v}, ${inner})`;
      }
      expr += access(s.key, neg);
    }
    if (neg) return `${expr} != optional.of(${literal(leaf.value!)})`;
    return `${expr} == ${literal(leaf.value!)}`;
  };
  if (op === "==") return build(leaf.path, "o", 0, false);
  // != through a list: "no element has it"
  if (leaf.path.some((s) => "index" in s)) {
    const i = leaf.path.findIndex((s) => "index" in s);
    const head = leaf.path.slice(0, i) as { key: string }[];
    const v = vars[0]!;
    const inner = build(leaf.path.slice(i + 1), v, 1, false);
    return `!o${head.map((s) => access(s.key, true)).join("")}.orValue([]).exists(${v}, ${inner})`;
  }
  return build(leaf.path, "o", 0, true);
}
