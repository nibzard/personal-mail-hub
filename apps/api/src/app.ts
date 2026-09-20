import cookie from "@fastify/cookie";
import Fastify from "fastify";

/**
 * The JSON body ceiling every route inherits. Fastify applies the same one
 * MiB by default; it stays explicit here so the one exception is visible:
 * the draft routes raise it for themselves, because a draft may carry one
 * million Markdown characters (SPEC F6).
 */
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/** Build the HTTP application without binding a network port. */
export function buildApp() {
  const app = Fastify({ logger: true, bodyLimit: JSON_BODY_LIMIT_BYTES });
  void app.register(cookie);

  return app;
}
