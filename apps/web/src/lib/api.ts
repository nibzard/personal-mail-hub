/*
 * Typed client for the API (SPEC section 6). Requests go to the same origin
 * through the `/api` prefix the deployment proxy routes to the Fastify
 * process. Set `VITE_API_BASE_URL` to point the client somewhere else.
 */

const DEFAULT_BASE = "/api";

function readBase(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (typeof configured !== "string" || configured.length === 0) {
    return DEFAULT_BASE;
  }
  return configured.replace(/\/+$/, "");
}

/** One API rejection: the HTTP status plus the error code from the body. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when the session is missing, expired, or revoked. */
  get unauthorized(): boolean {
    return this.status === 401;
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

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${readBase()}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { accept: "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    throw new ApiError(0, "network_error", "The mail service cannot be reached.");
  }

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
    throw new ApiError(response.status, code, message);
  }

  return payload as T;
}

/** One authenticated read. */
export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

/** One authenticated mutation or ceremony step. */
export function apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: "POST",
    signal,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
