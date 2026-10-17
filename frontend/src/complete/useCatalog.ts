import { useEffect, useState } from "react";
import { bridge } from "../store/store";
import type { Catalog } from "../transport/types";

const empty = (context: string): Catalog => ({ context, resources: [], namespaces: [], loading: false, gen: 0 });

/** Poll interval while the backend is still fetching. */
const LOADING_POLL_MS = 250;

/**
 * Completion data for a context while `active` (e.g. the dialog is open).
 * The backend fills it in asynchronously; this polls only while it loads.
 * The catalog is sent whole: a few hundred types, filtered client-side.
 */
export function useCatalog(context: string, active: boolean): Catalog {
  const [cat, setCat] = useState<Catalog>(() => empty(context));
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
            setCat((prev) => (prev.context === c.context && prev.gen === c.gen && c.gen !== 0 ? prev : c));
            if (c.loading) timer = setTimeout(load, LOADING_POLL_MS);
          },
          () => !stop && setCat(empty(context)),
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
