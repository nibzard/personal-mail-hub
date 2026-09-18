import { API_VERSION, type HealthResponse } from "@mail-hub/contracts";
import Fastify from "fastify";

/** Build the HTTP application without binding a network port. */
export function buildApp() {
  const app = Fastify({ logger: true });

  app.get<{ Reply: HealthResponse }>("/health", {
    schema: {
      response: {
        200: {
          type: "object",
          required: ["service", "status", "version"],
          properties: {
            service: { const: "api" },
            status: { const: "ok" },
            version: { const: API_VERSION }
          }
        }
      }
    }
  }, async () => ({ service: "api", status: "ok", version: API_VERSION }));

  return app;
}
