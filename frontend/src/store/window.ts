import { create } from "zustand";

/**
 * Which window this page is: "main" (kubewing's first window), or one a pane
 * was detached into ("w1", …; the page's ?window=). Each window has its own
 * UI state; panes move between them by handing over (store/transfer.ts).
 */
export const MAIN_WINDOW = "main";

// unit tests run without a page: the main window
export const windowName: string = (typeof location !== "undefined" && new URLSearchParams(location.search).get("window")) || MAIN_WINDOW;

export const isMainWindow = windowName === MAIN_WINDOW;

/** The windows open now (Go announces every change): a pane can be dragged to another one if there is one. */
export const useWindows = create<{ names: string[] }>(() => ({ names: [MAIN_WINDOW] }));

export const otherWindows = (names: string[]) => names.filter((n) => n !== windowName);
