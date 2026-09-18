import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { RecoveryErrorBody } from "@mail-hub/contracts";
import { RecoveryBlockedError, type MutationGate } from "@mail-hub/recovery";
import { buildApp } from "../src/app.ts";
import { RECOVERY_GENERATION_HEADER, mailMutationGate } from "../src/recovery.ts";

const GENERATION = "11111111-1111-4111-8111-111111111111";

const apps: FastifyInstance[] = [];

/** Build an app with one mutation route behind the recovery gate. */
function appWithGate(gate: MutationGate): FastifyInstance {
  const app = buildApp();
  app.post("/test-mutation", { preHandler: [mailMutationGate(gate)] }, async () => ({ ok: true }));
  apps.push(app);
  return app;
}

describe("the recovery gate preHandler", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("passes an allowed request to the route", async () => {
    const seen: (string | null | undefined)[] = [];
    const app = appWithGate({
      gateMutation: async (requestGeneration) => {
        seen.push(requestGeneration);
        return { generation: GENERATION };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/test-mutation",
      headers: { [RECOVERY_GENERATION_HEADER]: GENERATION.toUpperCase() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(seen).toEqual([GENERATION.toUpperCase()]);
  });

  it("rejects a request without a generation header with 400", async () => {
    const strict: MutationGate = {
      gateMutation: async (requestGeneration) => {
        if (requestGeneration === null || requestGeneration === undefined || requestGeneration === "") {
          throw new RecoveryBlockedError("invalid_recovery_generation");
        }
        return { generation: requestGeneration };
      },
    };
    const app = appWithGate(strict);

    const response = await app.inject({ method: "POST", url: "/test-mutation" });
    const body = response.json() as RecoveryErrorBody;

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe("invalid_recovery_generation");
  });

  it("maps an old generation to 409 recovery_required", async () => {
    const app = appWithGate({
      gateMutation: async () => {
        throw new RecoveryBlockedError("recovery_required", GENERATION);
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/test-mutation",
      headers: { [RECOVERY_GENERATION_HEADER]: "33333333-3333-4333-8333-333333333333" },
    });
    const body = response.json() as RecoveryErrorBody;

    expect(response.statusCode).toBe(409);
    expect(body.error.code).toBe("recovery_required");
    expect(body.error.currentGeneration).toBe(GENERATION);
  });

  it("maps recovery in progress to 503", async () => {
    const app = appWithGate({
      gateMutation: async () => {
        throw new RecoveryBlockedError("recovery_in_progress");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/test-mutation",
      headers: { [RECOVERY_GENERATION_HEADER]: GENERATION },
    });
    const body = response.json() as RecoveryErrorBody;

    expect(response.statusCode).toBe(503);
    expect(body.error.code).toBe("recovery_in_progress");
    expect(body.error.currentGeneration).toBeUndefined();
  });

  it("lets unrelated errors reach the default error handler", async () => {
    const app = appWithGate({
      gateMutation: async () => {
        throw new Error("unrelated");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/test-mutation",
      headers: { [RECOVERY_GENERATION_HEADER]: GENERATION },
    });

    expect(response.statusCode).toBe(500);
  });
});
