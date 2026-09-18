import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";

describe("GET /health", () => {
  const app = buildApp();

  afterEach(async () => {
    await app.close();
  });

  it("returns the API health contract", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "api", status: "ok", version: "v1" });
  });
});
