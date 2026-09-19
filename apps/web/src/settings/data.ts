import { useEffect, useState } from "react";
import type { SyncStatusResponse } from "@mail-hub/contracts";
import { apiGet, toApiError, type ApiError } from "@/lib/api";

/*
 * Settings data hooks (SPEC F10 and section 11): the per-account sync and
 * queue status the settings screen shows. It reads the same durable records
 * as `GET /healthz`, so the screen and the operator view can never disagree.
 */

/** The state of one sync-status read. */
export interface SyncStatusState {
  phase: "loading" | "ready" | "error";
  report: SyncStatusResponse | null;
  error: ApiError | null;
  reload: () => void;
}

/**
 * The synchronization and queue status, fetched while the settings screen is
 * open. A closed screen reads nothing.
 */
export function useSyncStatus(enabled: boolean): SyncStatusState {
  const [report, setReport] = useState<SyncStatusResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    let live = true;
    setPhase("loading");
    apiGet<SyncStatusResponse>("/sync/status", controller.signal).then(
      (response) => {
        if (!live) {
          return;
        }
        setReport(response);
        setPhase("ready");
        setError(null);
      },
      (cause: unknown) => {
        if (!live || (cause instanceof DOMException && cause.name === "AbortError")) {
          return;
        }
        setError(toApiError(cause));
        setPhase("error");
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [enabled, nonce]);

  return {
    phase,
    report,
    error,
    reload: () => setNonce((value) => value + 1),
  };
}
