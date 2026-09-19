import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReviewChoice, SyncSnapshot } from "@mail-hub/offline";
import { offlineSync } from "./port.ts";

/*
 * The React half of the offline contract (SPEC F9): the interface always
 * shows what has not synchronized. One provider owns the device's sync
 * controller. It observes the generation the session probe issued, replays
 * the queue when connectivity returns, and hands the review surface its
 * snapshot and resolution entry points.
 */

export interface OfflineSyncState {
  /** Null before the first snapshot arrived, or without IndexedDB. */
  snapshot: SyncSnapshot | null;
  online: boolean;
  /** True while a replay pass runs. */
  syncing: boolean;
  /** Observe a generation the session probe issued, then replay. */
  observe: (generation: string | null) => Promise<void>;
  /** Resolve one review item after its explicit step (SPEC F9). */
  resolve: (localId: string, choice: ReviewChoice) => Promise<void>;
}

const OfflineSyncContext = createContext<OfflineSyncState | null>(null);

export function OfflineSyncProvider({
  probeGeneration,
  children,
}: {
  /** The recovery generation of the latest session probe, when it had one. */
  probeGeneration: string | null;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<SyncSnapshot | null>(null);
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [syncing, setSyncing] = useState(false);
  const running = useRef(false);

  const refresh = useCallback(async (generation: string | null) => {
    const controller = offlineSync();
    if (controller === null) {
      return;
    }
    if (running.current) {
      return;
    }
    running.current = true;
    setSyncing(true);
    try {
      await controller.observeGeneration(generation);
      const report = await controller.sync();
      setSnapshot(report.snapshot);
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, []);

  // The session probe names the generation; observing it also replays the
  // queue, so a returning connection drains both.
  useEffect(() => {
    void refresh(probeGeneration);
  }, [probeGeneration, refresh]);

  useEffect(() => {
    const wentOnline = () => {
      setOnline(true);
      void refresh(probeGeneration);
    };
    const wentOffline = () => setOnline(false);
    window.addEventListener("online", wentOnline);
    window.addEventListener("offline", wentOffline);
    return () => {
      window.removeEventListener("online", wentOnline);
      window.removeEventListener("offline", wentOffline);
    };
  }, [probeGeneration, refresh]);

  const observe = refresh;

  const resolve = useCallback(
    async (localId: string, choice: ReviewChoice) => {
      const controller = offlineSync();
      if (controller === null) {
        return;
      }
      const next = await controller.resolveReview(localId, choice);
      setSnapshot(next);
      // The resolved item is pending again; drain it now.
      const report = await controller.sync();
      setSnapshot(report.snapshot);
    },
    [],
  );

  const value = useMemo<OfflineSyncState>(
    () => ({ snapshot, online, syncing, observe, resolve }),
    [snapshot, online, syncing, observe, resolve],
  );

  return <OfflineSyncContext.Provider value={value}>{children}</OfflineSyncContext.Provider>;
}

/** The offline sync state of this device. Throws outside the provider. */
export function useOfflineSync(): OfflineSyncState {
  const value = useContext(OfflineSyncContext);
  if (value === null) {
    throw new Error("useOfflineSync needs the OfflineSyncProvider.");
  }
  return value;
}
