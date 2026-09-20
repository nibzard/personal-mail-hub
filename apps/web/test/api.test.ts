// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet } from "../src/lib/api.ts";

/*
 * The request deadline (SPEC F9): a stalled connection must fail the way an
 * unreachable one does, so `ApiError.network` lands and the offline
 * fallbacks engage instead of the caller waiting forever. A caller's own
 * abort still surfaces as the abort the loaders already know to ignore.
 */

/** A fetch that never answers; only the request's signal can end it. */
function stalledFetch() {
  return vi.fn(
    (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the request deadline", () => {
  it("fails a stalled request like an unreachable service", async () => {
    vi.stubGlobal("fetch", stalledFetch());

    const failure = await apiGet("/search", undefined, { timeoutMs: 20 }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).network).toBe(true);
    expect((failure as ApiError).message).toBe("The mail service did not answer in time.");
  });

  it("still surfaces a caller's abort as an abort", async () => {
    vi.stubGlobal("fetch", stalledFetch());
    const controller = new AbortController();
    const request = apiGet("/search", controller.signal, { timeoutMs: 5_000 });
    controller.abort();

    const failure = await request.then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("AbortError");
  });

  it("releases the deadline once a request answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response,
      ),
    );

    await expect(apiGet("/accounts", undefined, { timeoutMs: 20 })).resolves.toEqual({});
  });
});
