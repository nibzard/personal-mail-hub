import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
// The access check is a plain Node script, so it carries no type
// declarations; the surface under test is small and pinned here.
// @ts-expect-error No declaration file for the deploy script.
import { ACCESS_ENV_KEYS, classifyDockerFailure, classifySshFailure, findUnsafeOperand, httpGet, parseAccessEnv } from "../../../deploy/access-check.mjs";

/**
 * Pure classification of the deploy/access-check.mjs operator check (T110).
 * The categories must stay honest: they name the missing capability, and
 * the runbook maps each one to an operator action.
 */

const SSH_MESSAGES: Array<[string, string]> = [
  ["ssh: connect to host 192.168.1.144 port 22: No route to host", "network_unreachable"],
  ["ssh: connect to host 10.0.0.9 port 22: Connection timed out", "network_unreachable"],
  ["ssh: connect to host 10.0.0.9 port 22: Operation timed out", "network_unreachable"],
  ["ssh: connect to host 10.0.0.9 port 22: Network is unreachable", "network_unreachable"],
  ["ssh: connect to host 10.0.0.9 port 22: Connection refused", "connection_refused"],
  ["ssh: Could not resolve hostname awc-pilot: Name or service not known", "hostname_unresolved"],
  [
    "@@@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@@\nHost key verification failed.",
    "host_key_mismatch",
  ],
  ["Host key verification failed.", "host_key_mismatch"],
  ["Warning: Identity file /home/x/.ssh/id missing not accessible.", "identity_unreadable"],
  ["Load key \"/home/x/.ssh/id_bad\": error in libcrypto", "identity_unreadable"],
  ["debian@192.168.1.144: Permission denied (publickey).", "ssh_auth_denied"],
  ["something entirely new", "ssh_failed"],
];

describe("classifySshFailure", () => {
  for (const [message, expected] of SSH_MESSAGES) {
    it(`reads ${JSON.stringify(message.slice(0, 40))} as ${expected}`, () => {
      expect(classifySshFailure(message)).toBe(expected);
    });
  }

  it("treats empty output as an unmapped failure, not a crash", () => {
    expect(classifySshFailure("")).toBe("ssh_failed");
    expect(classifySshFailure(undefined)).toBe("ssh_failed");
  });
});

describe("classifyDockerFailure", () => {
  it("reads a missing docker binary", () => {
    expect(classifyDockerFailure("sh: 1: docker: not found")).toBe("docker_missing");
  });

  it("reads a forbidden docker socket", () => {
    expect(
      classifyDockerFailure("permission denied while trying to connect to the Docker daemon socket"),
    ).toBe("docker_forbidden");
  });

  it("reads a stopped daemon", () => {
    expect(classifyDockerFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")).toBe(
      "docker_daemon_unreachable",
    );
  });

  it("reads unknown output as unavailable", () => {
    expect(classifyDockerFailure("everything failed at once")).toBe("docker_unavailable");
  });
});

describe("parseAccessEnv", () => {
  it("keeps only the whitelisted keys", () => {
    const parsed = parseAccessEnv(
      ["DEPLOY_SSH_HOST=awc-pilot", "PATH=/usr/bin:/bin", "BOGUS=1", "# comment", ""].join("\n"),
    );
    expect(parsed).toEqual({ DEPLOY_SSH_HOST: "awc-pilot" });
    expect(ACCESS_ENV_KEYS).not.toContain("PATH");
  });

  it("strips matching quotes but keeps inner equals signs", () => {
    expect(parseAccessEnv('DEPLOY_APP_URL="https://mail.example.com"')).toEqual({
      DEPLOY_APP_URL: "https://mail.example.com",
    });
    expect(parseAccessEnv("COOLIFY_TOKEN='abc'")).toEqual({ COOLIFY_TOKEN: "abc" });
    expect(parseAccessEnv("DEPLOY_COOLIFY_URL=https://x.example.com/a?b=c")).toEqual({
      DEPLOY_COOLIFY_URL: "https://x.example.com/a?b=c",
    });
  });

  it("ignores malformed lines", () => {
    expect(parseAccessEnv("=novalue\nDEPLOY_SSH_HOST\n123=bogus\n\nDEPLOY_APP_URL=https://m.example.com")).toEqual(
      { DEPLOY_APP_URL: "https://m.example.com" },
    );
  });

  it("returns nothing for missing or empty input", () => {
    expect(parseAccessEnv(undefined)).toEqual({});
    expect(parseAccessEnv("")).toEqual({});
  });
});

describe("findUnsafeOperand", () => {
  it("names the first value ssh would parse as an option", () => {
    expect(findUnsafeOperand({ DEPLOY_SSH_HOST: "-oProxyCommand=touch /tmp/x" })).toBe("DEPLOY_SSH_HOST");
    expect(
      findUnsafeOperand({ DEPLOY_SSH_HOST: "awc-pilot", DEPLOY_SSH_IDENTITY: "-i-other" }),
    ).toBe("DEPLOY_SSH_IDENTITY");
  });

  it("accepts ordinary host names, paths, and URLs", () => {
    expect(
      findUnsafeOperand({
        DEPLOY_SSH_HOST: "awc-pilot",
        DEPLOY_SSH_IDENTITY: "~/.ssh/id_ed25519_awc_pilot",
        DEPLOY_COOLIFY_URL: "https://coolify.example.com",
        DEPLOY_APP_URL: "https://mail.example.com",
      }),
    ).toBeNull();
    expect(findUnsafeOperand(undefined)).toBeNull();
  });
});

describe("httpGet", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
  });

  /** One stub that answers 200 only for the valid bearer token. */
  function stub(): Promise<string> {
    return new Promise((resolve) => {
      const server = createServer((request, response) => {
        const seen = request.headers.authorization ?? null;
        response.statusCode = seen === "Bearer valid-token" ? 200 : 401;
        response.end("{}");
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  it("sends the configured bearer token to the endpoint", async () => {
    const base = await stub();
    const response = await httpGet(`${base}/api/v1/teams`, { Authorization: "Bearer valid-token" });
    expect(response).toEqual({ ok: true, status: 200 });
  });

  it("reports the rejection a missing or wrong token earns", async () => {
    const base = await stub();
    const response = await httpGet(`${base}/api/v1/teams`, { Authorization: "Bearer wrong-token" });
    expect(response).toEqual({ ok: true, status: 401 });
    const bare = await httpGet(`${base}/api/v1/teams`, {});
    expect(bare).toEqual({ ok: true, status: 401 });
  });

  it("classifies an unreachable endpoint instead of throwing", async () => {
    const response = await httpGet("http://127.0.0.1:1/api/v1/teams", {});
    expect(response).toEqual({ ok: false, status: null });
  });
});
