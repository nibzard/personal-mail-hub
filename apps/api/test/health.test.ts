import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

/**
 * `GET /health` is gone. It answered a constant and checked nothing, while
 * `/healthz` runs the database round trip the SPEC, the container health
 * check, and `deploy/README.md` all monitor. The real check stays covered by
 * `health-routes.test.ts`.
 */
describe("GET /health", () => {
  const app = buildApp();

  afterEach(async () => {
    await app.close();
  });

  it("is not served; /healthz is the only health check", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(404);
  });
});
