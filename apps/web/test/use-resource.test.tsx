// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useResource, type Resource } from "../src/mail/use-resource.ts";

/*
 * The refresh rule of one async read (SPEC F12): a reload over the same
 * inputs keeps the last ready answer visible while the read runs, while new
 * inputs start from a blank slate, so one input's answer never shows under
 * another's load.
 */

const harness = vi.hoisted(() => ({
  open: [] as Array<(value: string) => void>,
}));

/** A loader the test parks and releases by hand, one call at a time. */
function gatedLoader(_signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    harness.open.push(resolve);
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let resource: { current: Resource<string> | null } = { current: null };
let currentDeps: ReadonlyArray<unknown> = [];

/** The probe renders the hook with whatever inputs the test last set. */
function Probe() {
  resource.current = useResource(gatedLoader, currentDeps);
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root !== null) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  harness.open.length = 0;
  currentDeps = [];
});

/** Mounts the hook behind the probe. */
function mountDep(deps: ReadonlyArray<unknown>): void {
  currentDeps = deps;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe />);
  });
}

/** Rerenders the probe with new inputs for the same hook instance. */
function rerenderDep(deps: ReadonlyArray<unknown>): void {
  currentDeps = deps;
  act(() => {
    root!.render(<Probe />);
  });
}

describe("useResource's refresh rule", () => {
  it("keeps the last ready answer visible while a reload runs", async () => {
    mountDep(["drafts"]);
    await act(async () => {
      harness.open[0]!("one");
    });
    expect(resource.current!.phase).toBe("ready");
    expect(resource.current!.data).toBe("one");

    // The reload starts a read that never answers; the old answer stays.
    act(() => {
      resource.current!.reload();
    });
    expect(resource.current!.phase).toBe("loading");
    expect(resource.current!.data).toBe("one");

    // The new answer replaces it only when it lands.
    await act(async () => {
      harness.open[1]!("two");
    });
    expect(resource.current!.phase).toBe("ready");
    expect(resource.current!.data).toBe("two");
  });

  it("starts from a blank slate when the inputs change", async () => {
    mountDep(["message-a"]);
    await act(async () => {
      harness.open[0]!("detail-a");
    });
    expect(resource.current!.data).toBe("detail-a");

    // Another message is another input: its load must not show the previous
    // message's answer while it runs.
    rerenderDep(["message-b"]);
    expect(resource.current!.phase).toBe("loading");
    expect(resource.current!.data).toBeNull();
    await act(async () => {
      harness.open[1]!("detail-b");
    });
    expect(resource.current!.data).toBe("detail-b");
  });
});
