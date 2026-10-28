import type * as Monaco from "monaco-editor/editor/editor.api.js";

/**
 * A JSON tokenizer for the viewer (a decoded value that's JSON), instead of
 * Monaco's JSON language service and its worker: keys as YAML's ("type"),
 * strings, numbers and true/false/null as YAML colors them. Folding is
 * Monaco's by brackets.
 */
export const jsonLanguage: Monaco.languages.IMonarchLanguage = {
  tokenPostfix: ".json",
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}[\]]/, "delimiter.bracket"],
      [/[,:]/, "delimiter"],
      [/\s+/, "white"],
    ],
  },
};

export const jsonConf: Monaco.languages.LanguageConfiguration = {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
};
