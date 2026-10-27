/**
 * Label selector completion helpers, pure: what the caret is completing in
 * a selector (`app=et|`, `tier in (a, |`) and the candidates for it.
 */
import type { Candidate } from "./complete";
import type { FieldKeys, FieldValues } from "../transport/types";

/** What the caret is completing in a label selector. */
export interface LabelContext {
  /** Start of the text being completed (replaced on accept). */
  from: number;
  /** The key, value or operator typed so far (what candidates are ranked against). */
  word: string;
  /** A key (`app`, `!app`), an operator after a key and a space (`app |`), or a value of key (`app=|`, `app in (a, |`). */
  at: "key" | "operator" | "value";
  key?: string;
  /** The values already in an `in (…)` list: not offered again. */
  listed?: string[];
}

const keyChars = String.raw`[A-Za-z0-9_./-]`;
const keyRe = new RegExp(String.raw`^\s*!?\s*(${keyChars}*)$`);
const valueRe = new RegExp(String.raw`^\s*(${keyChars}+)\s*(?:==?|!=)\s*([A-Za-z0-9_.-]*)$`);
const operatorRe = new RegExp(String.raw`^\s*(${keyChars}+)(\s+)([a-z]*)$`);
const listRe = new RegExp(String.raw`^\s*(${keyChars}+)\s+(?:in|notin)\s*\(([^)]*)$`);

/**
 * The completion context at the caret, within the requirement it is in
 * (after the last comma outside parentheses): `app=et|` → value of app,
 * word "et"; `env in (prod, s|` → value of env, word "s", prod listed.
 */
export function labelContext(src: string, caret: number): LabelContext | undefined {
  const before = src.slice(0, caret);
  let start = 0, open = false;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === "(") open = true;
    else if (ch === ")") open = false;
    else if (ch === "," && !open) start = i + 1;
  }
  const req = before.slice(start);
  if (open) {
    const m = req.match(listRe);
    if (!m) return undefined;
    const items = m[2]!.split(",");
    const word = items.pop()!.trimStart();
    return { from: caret - word.length, word, at: "value", key: m[1], listed: items.map((s) => s.trim()).filter(Boolean) };
  }
  let m = req.match(keyRe);
  if (m) return { from: caret - m[1]!.length, word: m[1]!, at: "key" };
  m = req.match(valueRe);
  if (m) return { from: caret - m[2]!.length, word: m[2]!, at: "value", key: m[1] };
  // the operator replaces the space after the key: `app |` → `app=`, `app in (`
  m = req.match(operatorRe);
  if (m) return { from: caret - m[3]!.length - m[2]!.length, word: m[3]!, at: "operator", key: m[1] };
  return undefined;
}

/** The label keys of the pane's objects (the detail: how many objects have the key). */
export function labelKeyCandidates(f: FieldKeys | undefined): Candidate[] {
  return (f?.keys ?? []).map((k) => ({ value: k.key, label: k.key, detail: `${k.count}/${f!.objects}` }));
}

/** A key's values on the pane's objects, without those already listed. */
export function labelValueCandidates(f: FieldValues | undefined, listed: string[] = []): Candidate[] {
  return (f?.values ?? []).filter((v) => !listed.includes(v.value)).map((v) => ({ value: v.value, label: v.value, detail: `${v.count}/${f!.objects}` }));
}

export const labelOperators: Candidate[] = [
  { value: "=", label: "=", detail: "equals" },
  { value: "!=", label: "!=", detail: "differs (or no such label)" },
  { value: " in (", label: "in (…)", detail: "one of" },
  { value: " notin (", label: "notin (…)", detail: "none of (or no such label)" },
];
