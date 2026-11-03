/**
 * Monaco, trimmed to a YAML/text viewer, diff viewer and the YAML editor: the
 * core API plus only the contributions we use (find, folding, sticky scroll,
 * bracket matching, copy, line operations: ⌥↑/⌥↓ move a line, ⌘D deletes it
 * in the editor; word operations: ⌥←/⌥→ step a word, ⇧ selecting) and the YAML tokenizer (and a small JSON one, see json.ts), instead of editor.main's
 * ~80 languages; YAML gets its own folding ranges (see yamlFoldingRanges),
 * which sticky scroll follows too. Loaded lazily (see loadMonaco); workers
 * are bundled by Vite, nothing is fetched from a CDN.
 */
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/common/standaloneStrings.js";
// CSS isn't in the package's exports map: imported by path
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";
import "monaco-editor/languages/definitions/yaml/register.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { yamlFoldingRanges } from "./yamlFolding";
import { jsonConf, jsonLanguage } from "./json";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.registerFoldingRangeProvider("yaml", {
  provideFoldingRanges: (model) => yamlFoldingRanges(model.getLinesContent()),
});

// ⌃← / ⌃→ fold / unfold the section at the cursor, in the viewer and the editor (Monaco's ⌥⌘[ / ⌥⌘] stay)
monaco.editor.addKeybindingRules([
  { keybinding: monaco.KeyMod.WinCtrl | monaco.KeyCode.LeftArrow, command: "editor.fold", when: "editorTextFocus" },
  { keybinding: monaco.KeyMod.WinCtrl | monaco.KeyCode.RightArrow, command: "editor.unfold", when: "editorTextFocus" },
]);

monaco.languages.register({ id: "json" });
monaco.languages.setMonarchTokensProvider("json", jsonLanguage);
monaco.languages.setLanguageConfiguration("json", jsonConf);

export { monaco };
