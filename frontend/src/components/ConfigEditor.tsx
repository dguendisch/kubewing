import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Editor } from "../editor/Editor";
import { Viewer } from "../editor/Viewer";
import { bridge, setUI, useUI } from "../store/store";
import * as S from "../store/state";
import type { ConfigFile } from "../transport/types";
import { keysProblems, keysReference, keysStarter } from "../keys/keysReference";

/** How long typing pauses before the text is checked. */
const CHECK_MS = 250;

/**
 * ⌘,: config.yaml in an editor, the reference (every setting with its
 * default and what it does) beside it. A new file starts as the reference
 * commented out: ⌘/ on a line brings the setting in. ⌥⌘,: keybindings.yaml
 * the same way, every default binding beside it (from the keymap; a new file
 * starts as a commented example). Problems show while typing (Go checks the
 * text as it would load it, the keymap the entries' commands, keys and
 * contexts); ⌘S writes the file and applies it, as ⌘⇧, does, and adds what
 * only loading the file finds (a font that isn't installed). Esc closes
 * (asking first while edits are unsaved).
 */
export function ConfigEditor() {
  const file = useUI((s) => (s.overlay?.kind === "config" ? s.overlay.configFile : undefined));
  if (!file) return null;
  return <Dialog key={file.path} file={file} />;
}

/** Per file: the dialog's name, the reference beside it and how a new file starts. */
function kindOf(file: ConfigFile) {
  if (file.file === "keybindings.yaml")
    return { title: "keyboard shortcuts", reference: keysReference(), refHint: "every default binding · copy what you need", starter: file.exists ? file.text : keysStarter, fresh: "new file: an example, commented out" };
  return { title: "settings", reference: file.reference ?? "", refHint: "every setting with its default · copy what you need", starter: file.text, fresh: "new file: every setting commented out" };
}

function Dialog({ file }: { file: ConfigFile }) {
  const [kind] = useState(() => kindOf(file));
  // the text on disk (or the starter, until the first save): "edited" compares with it
  const [saved, setSaved] = useState(kind.starter);
  const [exists, setExists] = useState(file.exists);
  const [text, setText] = useState(kind.starter);
  const [problems, setProblems] = useState<string[]>([]);
  // what only a save finds (checked as the file is loaded, not while typing: a font that isn't installed)
  const [saveProblems, setSaveProblems] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // a new config.yaml is the reference already (commented out); otherwise it's beside the file
  const [showRef, setShowRef] = useState(file.exists || file.file === "keybindings.yaml");
  // Esc on unsaved edits asks first (a second Esc drops them): WKWebView has no window.confirm
  const [dropAsked, setDropAsked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const problemsRef = useRef(problems);
  problemsRef.current = problems;
  const edited = text !== saved;

  useEffect(() => {
    let stale = false;
    const t = setTimeout(
      () =>
        void bridge()
          .checkConfig(file.file, text)
          .then((c) => !stale && setProblems([...c.problems, ...(file.file === "keybindings.yaml" ? keysProblems(c.keybindings) : [])]), () => {}),
      CHECK_MS,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [text, file.file]);

  const close = () => setUI((s) => (s.overlay?.kind === "config" ? S.closeOverlay(s) : s));
  const saving = useRef(false);
  const save = () => {
    if (saving.current) return;
    saving.current = true;
    const t = textRef.current;
    setBusy(true);
    setError(undefined);
    // the kw:config event applies it everywhere (theme, keys, rules …), the banner its problems
    void bridge()
      .saveConfig(file.file, t)
      .then(
        (cfg) => {
          setSaved(t);
          setExists(true);
          setDone(true);
          // the saved file's problems the live check doesn't have (the rest it shows already)
          const prefix = `${file.file}: `;
          setSaveProblems(cfg.errors.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)).filter((e) => !problemsRef.current.includes(e)));
        },
        (e) => setError(String((e as Error)?.message ?? e)),
      )
      .finally(() => {
        saving.current = false;
        setBusy(false);
      });
  };
  // a click on a button keeps the focus where it was (the editor): WKWebView doesn't focus a clicked
  // button, so the focus would be nowhere and Esc wouldn't reach the dialog
  const keepFocus = (e: MouseEvent) => e.preventDefault();
  // the reference hidden while it had the focus: the dialog takes it, for Esc and ⌘S
  useEffect(() => {
    if (root.current && !root.current.contains(document.activeElement)) root.current.focus();
  }, [showRef]);
  const escape = () => {
    if (edited && !dropAsked) return setDropAsked(true);
    close();
  };

  const hint = busy
    ? "saving…"
    : dropAsked
      ? "esc again drops the edits"
      : "⌘S save and apply · ⌘/ comment a line in or out · esc close";
  const state = edited ? (
    <span className="text-changed">edited</span>
  ) : done ? (
    <span className="text-added">saved and applied{problems.length || saveProblems.length ? ", defaults used where there are problems" : ""}</span>
  ) : !exists ? (
    <span>{kind.fresh}</span>
  ) : null;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={kind.title}
      // focusable: a click on its empty parts keeps the keys in the dialog
      tabIndex={-1}
      className="absolute outline-none top-10 left-1/2 z-30 flex h-[calc(100vh-6rem)] w-[min(112rem,96vw)] -translate-x-1/2 flex-col gap-2 border border-accent bg-bg-elev p-3 shadow-dialog"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Monaco's find widget closes first
          if (e.target instanceof Element && e.target.closest(".find-widget.visible")) return;
          e.preventDefault();
          return escape();
        }
        // ⌘S from the buttons too (the editor handles its own)
        const inEditor = e.target instanceof Element && e.target.closest("[data-editor]");
        if (!inEditor && e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "KeyS") {
          e.preventDefault();
          save();
        }
      }}
    >
      <div className="flex items-baseline gap-2 text-fg-muted">
        <span className="text-fg">{kind.title}</span>
        <span className="truncate select-text">{file.path}</span>
        {state}
        <button
          type="button"
          aria-pressed={showRef}
          onMouseDown={keepFocus}
          onClick={() => setShowRef((v) => !v)}
          className={`ml-auto rounded border px-1.5 ${showRef ? "border-accent text-fg" : "border-border"} hover:border-accent`}
        >
          reference
        </button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-w-0 flex-1 border border-border">
          <Editor
            label={file.file}
            initial={kind.starter}
            onChange={(t) => {
              setDropAsked(false);
              setDone(false);
              setSaveProblems([]);
              setText(t);
            }}
            onSave={save}
          />
        </div>
        {showRef ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-fg-muted">{kind.refHint}</div>
            <div className="min-h-0 flex-1 border border-border">
              <Viewer label="reference" slot={`config/reference/${file.file}`} value={kind.reference} />
            </div>
          </div>
        ) : null}
      </div>
      {problems.length || saveProblems.length ? (
        <ul role="alert" aria-label="config problems" className="max-h-24 overflow-auto text-deleted">
          {[...problems, ...saveProblems].map((p, i) => (
            <li key={i} className="select-text">
              {p}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <div role="alert" className="text-deleted select-text">
          {error}
        </div>
      ) : null}
      <div className="flex items-center gap-2 text-fg-muted">
        <span className={dropAsked ? "text-changed" : ""}>{hint}</span>
        <button type="button" onMouseDown={keepFocus} onClick={save} disabled={busy} className="ml-auto rounded border border-border px-1.5 text-fg hover:border-accent disabled:opacity-60">
          save
        </button>
      </div>
    </div>
  );
}
