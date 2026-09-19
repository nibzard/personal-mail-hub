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
import type { AppSettings, SettingsResponse, SettingsUpdateBody } from "@mail-hub/contracts";
import { apiGet, apiPut, toApiError, type ApiError } from "@/lib/api";
import { setDensity } from "@/density";
import { setSingleKeyShortcuts } from "@/shortcuts";
import { setTheme } from "@/theme";

/*
 * Server-stored settings (SPEC F10): the settings table is the record, and
 * this provider is its client. On load it adopts the stored choice for
 * theme, density, single-key shortcuts, and the clean-view default, so
 * every device converges; the local stores keep the last choice for the
 * first paint and for offline starts. A change applies locally at once and
 * persists through the recovery-gated route, with an honest save state the
 * settings screen shows in one stable place (SPEC F12).
 */

/** The values a fresh installation starts with (SPEC F10). */
export const DEFAULT_APPLICATION_SETTINGS: AppSettings = {
  theme: "system",
  density: "compact",
  singleKeyShortcuts: true,
  cleanViewDefault: false,
  classificationEnabled: false,
  classificationMonthlyCostCapUsd: null,
  backfillClassification: false,
};

/** Where a settings change stands (SPEC F12: unsaved, saving, saved, error). */
export type SettingsSavePhase = "idle" | "saving" | "saved" | "error";

export interface SettingsState {
  phase: "loading" | "ready" | "error";
  settings: AppSettings;
  error: ApiError | null;
  /** Applies one patch locally, then persists it (SPEC F12). */
  update: (patch: SettingsUpdateBody) => void;
  /** Sends the last failed patch again, after an explicit choice (SPEC F12). */
  retry: () => void;
  reload: () => void;
  savePhase: SettingsSavePhase;
  saveError: string | null;
}

const SettingsContext = createContext<SettingsState | null>(null);

export function SettingsProvider({
  recoveryGeneration,
  children,
}: {
  /** The generation mutations must carry (SPEC section 7). */
  recoveryGeneration: string | null;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APPLICATION_SETTINGS);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [savePhase, setSavePhase] = useState<SettingsSavePhase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // The stored appearance choices are adopted once; afterwards the local
  // stores can hold newer edits that have not saved yet.
  const adopted = useRef(false);
  // The last patch that failed to save, kept for the explicit retry.
  const failedPatch = useRef<SettingsUpdateBody | null>(null);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    apiGet<SettingsResponse>("/settings", controller.signal).then(
      (response) => {
        if (!live) {
          return;
        }
        setSettings(response.settings);
        setPhase("ready");
        setError(null);
        if (!adopted.current) {
          adopted.current = true;
          setTheme(response.settings.theme);
          setDensity(response.settings.density);
          setSingleKeyShortcuts(response.settings.singleKeyShortcuts);
        }
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
  }, [nonce]);

  const update = useCallback(
    (patch: SettingsUpdateBody) => {
      setSettings((current) => ({ ...current, ...patch }));
      applyLocally(patch);
      setSavePhase("saving");
      setSaveError(null);
      apiPut<SettingsResponse>(
        "/settings",
        patch,
        recoveryGeneration === null
          ? undefined
          : { headers: { "x-recovery-generation": recoveryGeneration } },
      ).then(
        (response) => {
          failedPatch.current = null;
          setSettings(response.settings);
          setSavePhase("saved");
        },
        (cause: unknown) => {
          // The patch stays entered and inspectable; only an explicit retry
          // sends it again (SPEC F12).
          failedPatch.current = patch;
          setSavePhase("error");
          setSaveError(toApiError(cause).message);
        },
      );
    },
    [recoveryGeneration],
  );

  const retry = useCallback(() => {
    const patch = failedPatch.current;
    if (patch !== null) {
      update(patch);
    }
  }, [update]);

  const value = useMemo<SettingsState>(
    () => ({ phase, settings, error, update, retry, reload, savePhase, saveError }),
    [phase, settings, error, update, retry, reload, savePhase, saveError],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** The application settings. Throws outside the provider. */
export function useAppSettings(): SettingsState {
  const value = useContext(SettingsContext);
  if (value === null) {
    throw new Error("useAppSettings needs the SettingsProvider.");
  }
  return value;
}

/** Paint the appearance choices a patch carries. */
function applyLocally(patch: SettingsUpdateBody): void {
  if (patch.theme !== undefined) {
    setTheme(patch.theme);
  }
  if (patch.density !== undefined) {
    setDensity(patch.density);
  }
  if (patch.singleKeyShortcuts !== undefined) {
    setSingleKeyShortcuts(patch.singleKeyShortcuts);
  }
}
