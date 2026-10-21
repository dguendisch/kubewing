/**
 * CEL filter helpers, pure: completion context and candidates for the
 * filter field, and building a filter from a line of an object's YAML.
 */
import type { Candidate } from "./complete";
import type { FieldKeys } from "../transport/types";

/** What the caret is completing in a CEL draft. */
export interface CelContext {
  /** Start of the text being completed (replaced on accept). */
  from: number;
  /** The key, function or operator typed so far (what candidates are ranked against). */
  word: string;
  /**
   * Object path the word is a key of ([] = top level of `o`), or undefined
   * when the word isn't a field of `o` (a function, a macro variable …).
   * One step per key as it is in the object, so `labels["app.kubernetes.io/name"]`
   * is the steps labels, app.kubernetes.io/name.
   */
  path?: string[];
  /**
   * How the key is being written, from `from` on: after a dot (`.co|`), or
   * in brackets (`["app.k|`); optional for `.?` / `[?`.
   */
  access?: { bracket: boolean; optional: boolean };
  /**
   * Set where an operator goes (`o.status.phase |`, `o.a == 1 &|`): the
   * left operand's field path if it's a field of `o` (operators then fit
   * its type), literal if it's a value.
   */
  operator?: { path?: string[]; literal?: boolean };
}

const ident = /[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The completion context at the caret: `o.status.co|` → path [status],
 * word "co"; `o.metadata.labels["app.k|` → path [metadata, labels], word
 * "app.k". A chain through a macro variable (`exists(c, c.ima|)`) continues
 * at the list the variable ranges over.
 */
export function celContext(src: string, caret: number): CelContext | undefined {
  const before = src.slice(0, caret);
  const q = openQuote(before);
  if (q >= 0) {
    // a quoted key being typed: `["app.k|` or `[?"app.k|`
    const optional = before.slice(q - 2, q) === "[?";
    const open = optional ? q - 2 : q - 1;
    if (before[open] !== "[") return undefined; // a string literal: nothing to complete
    const path = chainAt(before.slice(0, open))?.path;
    if (!path) return undefined;
    return { from: open, word: before.slice(q + 1).replace(/\\(.)/g, "$1"), path, access: { bracket: true, optional } };
  }
  const op = operatorContext(before);
  if (op) return op;
  const word = before.match(ident)?.[0] ?? "";
  const dot = before.slice(0, caret - word.length).match(/\.(\?)?$/);
  if (!dot) return { from: caret - word.length, word };
  const from = caret - word.length - dot[0].length;
  const path = chainAt(before.slice(0, from))?.path;
  if (!path) return { from: caret - word.length, word };
  return { from, word, path, access: { bracket: false, optional: !!dot[1] } };
}

/** Index of the quote that opens the string the text ends in, or -1. */
function openQuote(text: string): number {
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (open >= 0) {
      if (ch === "\\") i++;
      else if (ch === text[open]) open = -1;
    } else if (ch === '"' || ch === "'") open = i;
  }
  return open;
}

const step = String.raw`(?:\.\??[A-Za-z_][A-Za-z0-9_]*|\[\??(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\]|\[\d+\])`;
// the root starts after a non-word character: `1e3` is a number, not `e3`
const chainRe = new RegExp(String.raw`(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)(${step}*)$`);
const stepRe = new RegExp(step, "g");

/**
 * The access chain the text ends with: `o.spec.?containers[0]`, `x.ports`,
 * `o.metadata.labels["app.kubernetes.io/name"]`. path is the field path if
 * it starts at `o` or a macro variable over a list of `o`; index steps are
 * skipped (keys of a list are its elements'). undefined = no chain here.
 */
function chainAt(text: string): { root: string; steps: number; element: boolean; path?: string[] } | undefined {
  const m = text.match(chainRe);
  if (!m) return undefined;
  const [all, root, rest] = m;
  const steps = [...rest!.matchAll(stepRe)].map((s) => s[0]);
  const keys = steps.filter((s) => !/^\[\d+\]$/.test(s)).map(stepKey);
  const element = /^\[\d+\]$/.test(steps[steps.length - 1] ?? "");
  if (root === "o") return { root, steps: steps.length, element, path: keys };
  const bound = macroVar(text.slice(0, text.length - all!.length), root!);
  return { root: root!, steps: steps.length, element, path: bound && [...bound, ...keys] };
}

/** The key of one access step: `.?a` → a, `["a.b/c"]` → a.b/c. */
function stepKey(s: string): string {
  if (s.startsWith(".")) return s.replace(/^\.\??/, "");
  const lit = s.replace(/^\[\??/, "").slice(0, -1);
  if (lit.startsWith('"')) return JSON.parse(lit) as string;
  return lit.slice(1, -1).replace(/\\(.)/g, "$1");
}

/** The operator position at the end of `before`, if it is one. */
function operatorContext(before: string): CelContext | undefined {
  const sym = before.match(/[=!<>&|]+$/)?.[0];
  const word = sym ?? before.match(ident)?.[0] ?? "";
  const from = before.length - word.length;
  const left = before.slice(0, from);
  // a word (only `in` is an operator) or nothing follows its operand after a space: `o.a|` still completes the key
  if (!sym && (!/\s$/.test(left) || !"in".startsWith(word))) return undefined;
  const operand = left.trimEnd();
  const chain = chainAt(operand);
  if (chain) {
    if (!chain.steps && chain.root === "in") return undefined;
    if (!chain.steps && ["true", "false", "null"].includes(chain.root)) return { from, word, operator: { literal: true } };
    // a bare variable or a list element: of unknown type
    if (!chain.steps || chain.element) return { from, word, operator: {} };
    return { from, word, operator: { path: chain.path } };
  }
  if (/["'\d]$/.test(operand)) return { from, word, operator: { literal: true } };
  // a call or index: of unknown type
  if (/[)\]]$/.test(operand)) return { from, word, operator: {} };
  return undefined;
}

/** Path of the list a macro variable ranges over: `o.x.y.exists(v,` → [x, y]. */
function macroVar(before: string, name: string): string[] | undefined {
  const re = new RegExp(String.raw`\.(?:exists|all|exists_one|map|filter)\(\s*${name}\s*,`, "g");
  let last: RegExpExecArray | undefined;
  for (const m of before.matchAll(re)) last = m;
  return last && chainAt(before.slice(0, last.index))?.path;
}

/**
 * Candidates for a key position: the keys at the path (the detail shows
 * the type and how many objects have the key), written as the position
 * needs. A key that isn't an identifier (`app.kubernetes.io/name`, `x-prop`)
 * or that CEL reads as a literal or operator (`in`, `true` …) goes in
 * brackets: `["app.kubernetes.io/name"]`. kubewing evaluates schemaless
 * objects, where Kubernetes' `__dot__` escaping doesn't apply. After a plain
 * dot, the member functions follow.
 */
export function keyCandidates(f: FieldKeys | undefined, ctx: CelContext): Candidate[] {
  const a = ctx.access ?? { bracket: false, optional: false };
  const keys = (f?.keys ?? []).map((k) => ({
    value: a.bracket ? bracketed(k.key, a.optional) : access(k.key, a.optional),
    label: k.key,
    detail: `${k.type} · ${k.count}/${f!.objects}`,
  }));
  if (a.bracket || a.optional || !ctx.path?.length) return keys;
  return [...keys, ...celFunctions.map((c) => ({ ...c, value: `.${c.value}` }))];
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

const op = (o: string, detail: string): Candidate => ({ value: `${o} `, label: o, detail });
const equality = [op("==", "equals"), op("!=", "differs")];
const ordering = [op("<", "less than"), op("<=", "at most"), op(">", "greater than"), op(">=", "at least")];
const logical = [op("&&", "and"), op("||", "or")];
const oneOf: Candidate = { value: "in [", label: "in […]", detail: "one of" };

/**
 * Operators after an operand, for the field's type where known (as
 * FieldKeys reports it). Strings keep the ordering ones: timestamps are
 * RFC 3339 strings, which compare in time order.
 */
export function operatorCandidates(operator: NonNullable<CelContext["operator"]>, type?: string): Candidate[] {
  if (operator.literal) return [...logical, op("in", "in a list, key of a map")];
  switch (type) {
    case "string":
      return [...equality, oneOf, ...ordering];
    case "int":
    case "double":
      return [...equality, ...ordering, oneOf];
    case "bool":
      return [...logical, ...equality];
    case "map":
    case "list":
      return equality;
    default:
      return [...equality, ...ordering, oneOf, ...logical];
  }
}

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

// identifiers that can't follow a dot: cel-go reads them as an operator or literal
// (the other reserved words, `namespace` among them, work as field names)
const notAField = new Set(["in", "true", "false", "null"]);

/** `.name`, or `["name"]` where CEL syntax needs it (dots, slashes, dashes, `in` …). */
function access(key: string, optional: boolean): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !notAField.has(key);
  return plain ? (optional ? `.?${key}` : `.${key}`) : bracketed(key, optional);
}

function bracketed(key: string, optional: boolean): string {
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
