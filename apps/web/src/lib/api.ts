/*
 * Typed client for the API (SPEC section 6). Requests go to the same origin
 * through the `/api` prefix the deployment proxy routes to the Fastify
 * process. Set `VITE_API_BASE_URL` to point the client somewhere else.
 * Every request carries a deadline: a stalled connection fails like an
 * unreachable service, so the offline fallbacks can engage (SPEC F9).
 */

const DEFAULT_BASE = "/api";

/** How long one JSON request may run before the client gives up on it. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Byte transfers run longer: a 25 MB file on a slow link is legal (SPEC F6). */
export const TRANSFER_TIMEOUT_MS = 120_000;

function readBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (typeof configured !== "string" || configured.length === 0) {
    return DEFAULT_BASE;
  }
  return configured.replace(/\/+$/, "");
}

/** One API rejection: the HTTP status plus the error code from the body. */
export class ApiError extends Error {
  /**
   * The recovery generation the server accepts now, when the rejection was
   * a recovery gate refusal (SPEC section 10).
   */
  readonly currentGeneration?: string;

  /**
   * The revision the server holds now, when the rejection was a stale
   * draft revision (SPEC F6 and F9).
   */
  readonly currentRevision?: number;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    currentGeneration?: string,
    currentRevision?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.currentGeneration = currentGeneration;
    this.currentRevision = currentRevision;
  }

  /** True when the session is missing, expired, or revoked. */
  get unauthorized(): boolean {
    return this.status === 401;
  }

  /** True when the request never reached the service. */
  get network(): boolean {
    return this.status === 0;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Wrap anything a loader threw in an `ApiError` the interface can show. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  return new ApiError(0, "unexpected", "Something went wrong while contacting the mail service.");
}

/** One request deadline, as the fetch signal and the release it needs. */
interface Deadline {
  signal: AbortSignal;
  /** True when the deadline itself ended the call, not a caller's abort. */
  timedOut(): boolean;
  /** Releases the timer and the caller-signal listener when the call ends. */
  done(): void;
}

/**
 * Bounds one request in time. Without a deadline a stalled connection never
 * rejects, so no `ApiError.network` ever lands and the offline fallbacks
 * never engage (SPEC F9). A caller's own abort still applies at once.
 */
function withDeadline(ms: number, signal: AbortSignal | null | undefined): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, ms);
  const forwardAbort = () => controller.abort();
  if (signal != null) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

async function request<T>(
  path: string,
  init: RequestInit,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const deadline = withDeadline(options.timeoutMs ?? REQUEST_TIMEOUT_MS, init.signal);
  try {
    const response = await fetch(`${readBase()}${path}`, {
      credentials: "same-origin",
      ...init,
      signal: deadline.signal,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });

    if (response.status === 204) {
      return undefined as T;
    }

    let payload: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const body = payload as { error?: { code?: unknown; message?: unknown } } | null;
      const code =
        typeof body?.error?.code === "string" ? body.error.code : `http_${response.status}`;
      const message =
        typeof body?.error?.message === "string"
          ? body.error.message
          : `The request failed with status ${response.status}.`;
      const currentGeneration =
        typeof (body?.error as { currentGeneration?: unknown } | undefined)?.currentGeneration ===
        "string"
          ? (body!.error as { currentGeneration: string }).currentGeneration
          : undefined;
      const currentRevision =
        typeof (body?.error as { currentRevision?: unknown } | undefined)?.currentRevision ===
        "number"
          ? (body!.error as { currentRevision: number }).currentRevision
          : undefined;
      throw new ApiError(response.status, code, message, currentGeneration, currentRevision);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (deadline.timedOut()) {
      // A stalled connection fails like an unreachable one, so the offline
      // fallbacks engage instead of the request waiting forever.
      throw new ApiError(0, "network_error", "The mail service did not answer in time.");
    }
    if (isAbort(error)) {
      throw error;
    }
    throw new ApiError(0, "network_error", "The mail service cannot be reached.");
  } finally {
    deadline.done();
  }
}

/** One authenticated read. */
export function apiGet<T>(
  path: string,
  signal?: AbortSignal,
  options?: { timeoutMs?: number },
): Promise<T> {
  return request<T>(path, { method: "GET", signal }, options);
}

/** The URL of one API path, for links the browser navigates by itself. */
export function apiUrl(path: string): string {
  return `${readBase()}${path}`;
}

/** One authenticated binary read, as a blob. */
export async function apiGetBlob(
  path: string,
  signal?: AbortSignal,
  options?: { timeoutMs?: number },
): Promise<Blob> {
  const deadline = withDeadline(options?.timeoutMs ?? TRANSFER_TIMEOUT_MS, signal);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "*/*" },
      signal: deadline.signal,
    });
    if (!response.ok) {
      throw new ApiError(response.status, `http_${response.status}`, `The download failed with status ${response.status}.`);
    }
    const blob = await response.blob();
    if (deadline.timedOut()) {
      throw new ApiError(0, "network_error", "The mail service did not answer in time.");
    }
    return blob;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (deadline.timedOut()) {
      throw new ApiError(0, "network_error", "The mail service did not answer in time.");
    }
    if (isAbort(error)) {
      throw error;
    }
    throw new ApiError(0, "network_error", "The mail service cannot be reached.");
  } finally {
    deadline.done();
  }
}

/** One authenticated mutation or ceremony step. */
export function apiPost<T>(
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  return request<T>(path, {
    method: "POST",
    signal: options?.signal,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(options?.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** One authenticated patch, for revision-aware draft edits (SPEC F6). */
export function apiPatch<T>(
  path: string,
  body: unknown,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    signal: options?.signal,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

/** One authenticated put, for whole-value replaces such as identities. */
export function apiPut<T>(
  path: string,
  body: unknown,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    signal: options?.signal,
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    body: JSON.stringify(body),
  });
}

/** One authenticated delete, for clearing a value such as a folder role. */
export function apiDelete<T>(
  path: string,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
): Promise<T> {
  return request<T>(path, { method: "DELETE", signal: options?.signal, headers: options?.headers });
}

/** One authenticated byte upload, sent verbatim (SPEC F6). */
export function apiPostBytes<T>(
  path: string,
  bytes: Blob,
  contentType: string,
  headers?: Record<string, string>,
): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "content-type": contentType, ...(headers ?? {}) },
      body: bytes,
    },
    { timeoutMs: TRANSFER_TIMEOUT_MS },
  );
}
