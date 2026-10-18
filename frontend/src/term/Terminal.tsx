import { useEffect, useRef } from "react";
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { chord, resolve } from "../keys/keymap";
import { useConfig } from "../store/config";
import { sessions } from "./sessions";

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`).trim();

function theme(): ITheme {
  return {
    background: token("bg"),
    foreground: token("fg"),
    cursor: token("accent"),
    cursorAccent: token("bg"),
    selectionBackground: token("bg-hover"),
    red: token("deleted"),
    green: token("added"),
    yellow: token("changed"),
    magenta: token("hidden"),
  };
}

interface Props {
  session: string;
  focused: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onExit?: (code: number | string) => void;
  onFocus?: () => void;
}

/**
 * xterm.js terminal for one session. Every key goes to the shell except the
 * app's ⌘ chords (see keymap.terminalReserved), which xterm lets through to
 * the global handler. Output streams from `sessions`, bypassing React.
 */
export function Terminal({ session, focused, onInput, onResize, onExit, onFocus }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm>(undefined);
  const themeGen = useConfig((s) => s.themeGen);
  const cb = useRef({ onInput, onResize, onExit, onFocus });
  cb.current = { onInput, onResize, onExit, onFocus };

  useEffect(() => {
    const t = new XTerm({
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    term.current = t;
    // false = xterm ignores the key; the app's capture-phase handler has it already
    t.attachCustomKeyEventHandler((e) => !(e.type === "keydown" && resolve(chord(e), "terminal")));
    const subs = [t.onData((d) => cb.current.onInput(d)), t.onResize(({ cols, rows }) => cb.current.onResize(cols, rows))];
    const ro = new ResizeObserver(() => {
      if (host.current?.offsetWidth) fit.fit();
    });
    ro.observe(host.current!);
    fit.fit();
    cb.current.onResize(t.cols, t.rows);
    const detach = sessions.attach(session, (c) => {
      if (c instanceof Uint8Array) t.write(c);
      else {
        t.write(`\r\n\x1b[2m[process exited: ${c.exit}]\x1b[0m\r\n`);
        cb.current.onExit?.(c.exit);
      }
    });
    const onFocusIn = () => cb.current.onFocus?.();
    host.current!.addEventListener("focusin", onFocusIn);
    const el = host.current!;
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      detach();
      ro.disconnect();
      subs.forEach((s) => s.dispose());
      t.dispose();
      term.current = undefined;
    };
  }, [session]);

  useEffect(() => {
    if (focused) term.current?.focus();
    else term.current?.blur();
  }, [focused]);

  useEffect(() => {
    if (term.current && themeGen) term.current.options.theme = theme();
  }, [themeGen]);

  return <div ref={host} data-terminal={session} className="h-full w-full overflow-hidden p-1" />;
}
