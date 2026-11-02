import { useEffect, useState } from "react";
import { bridge } from "../store/store";
import type { Catalog } from "../transport/types";

/** Catalog plus whether a backend reply has arrived yet (before that, nothing about it is known). */
export type CatalogState = Catalog & { ready: boolean };

const empty = (context: string): CatalogState => ({ context, resources: [], namespaces: [], loading: false, gen: 0, ready: false });

/** Poll interval while the backend is still fetching. */
const LOADING_POLL_MS = 250;

/**
 * Completion data for a context while `active` (e.g. the dialog is open).
 * The backend fills it in asynchronously; this polls only while it loads.
 * The catalog is sent whole: a few hundred types, filtered client-side.
 */
export function useCatalog(context: string, active: boolean): CatalogState {
  const [cat, setCat] = useState<CatalogState>(() => empty(context));
  useEffect(() => {
    if (!active) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      bridge()
        .catalog(context)
        .then(
          (c) => {
            if (stop) return;
            // lists Go sent as null (none yet) are empty ones
            setCat((prev) => (prev.context === c.context && prev.gen === c.gen && c.gen !== 0 ? prev : { ...c, resources: c.resources ?? [], namespaces: c.namespaces ?? [], ready: true }));
            if (c.loading) timer = setTimeout(load, LOADING_POLL_MS);
          },
          () => !stop && setCat({ ...empty(context), ready: true }),
        );
    setCat((prev) => (prev.context === context ? prev : empty(context)));
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [context, active]);
  return cat;
}
