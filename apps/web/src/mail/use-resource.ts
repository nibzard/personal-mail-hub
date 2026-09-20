import { useCallback, useEffect, useRef, useState } from "react";
import { toApiError, type ApiError } from "@/lib/api";

/*
 * One async read with loading, ready, and error phases (SPEC F12: keep
 * existing content visible during refresh, and keep failures inspectable).
 * `deps` name the load's inputs, like an effect dependency list; `reload`
 * re-runs the loader for the same inputs. A rerun over the same inputs keeps
 * the last ready answer in `data` while it loads, so a refresh never blanks
 * the content it refreshes; new inputs start from `data: null`, so one
 * input's answer never shows under another's load.
 */

export interface Resource<T> {
  phase: "loading" | "ready" | "error";
  data: T | null;
  error: ApiError | null;
  reload: () => void;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
): Resource<T> {
  const [entry, setEntry] = useState<{
    phase: "loading" | "ready" | "error";
    data: T | null;
    error: ApiError | null;
  }>({ phase: "loading", data: null, error: null });
  const [nonce, setNonce] = useState(0);
  // The inputs the last run loaded for. A rerun over the same inputs — only
  // a `reload` — is a refresh, the one case that keeps the last answer
  // visible while the read runs (SPEC F12).
  const lastDeps = useRef<ReadonlyArray<unknown> | null>(null);

  useEffect(
    () => {
      const controller = new AbortController();
      let live = true;
      const refresh =
        lastDeps.current !== null &&
        lastDeps.current.length === deps.length &&
        lastDeps.current.every((value, index) => Object.is(value, deps[index]));
      lastDeps.current = deps;
      setEntry((current) =>
        refresh && current.data !== null
          ? { phase: "loading", data: current.data, error: null }
          : { phase: "loading", data: null, error: null },
      );
      load(controller.signal).then(
        (data) => {
          if (live) {
            setEntry({ phase: "ready", data, error: null });
          }
        },
        (error: unknown) => {
          if (!live || (error instanceof DOMException && error.name === "AbortError")) {
            return;
          }
          setEntry({ phase: "error", data: null, error: toApiError(error) });
        },
      );
      return () => {
        live = false;
        controller.abort();
      };
    },
    // The caller names the inputs; spreading them keeps the list exact.
    [...deps, nonce],
  );

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { phase: entry.phase, data: entry.data, error: entry.error, reload };
}
