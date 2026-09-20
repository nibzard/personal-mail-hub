import { describe, expect, it } from "vitest";
import { runAdminCommand } from "../src/main.ts";

describe("runAdminCommand", () => {
  it("prints usage and fails without a command", async () => {
    await expect(runAdminCommand([], { DATABASE_URL: "postgres://localhost/mail" })).resolves.toBe(1);
  });

  it("prints usage and fails for an unknown command", async () => {
    await expect(runAdminCommand(["purge", "all"], { DATABASE_URL: "postgres://localhost/mail" })).resolves.toBe(1);
  });

  it("prints usage and fails for a command group without a subcommand", async () => {
    await expect(runAdminCommand(["recovery"], { DATABASE_URL: "postgres://localhost/mail" })).resolves.toBe(1);
  });

  it("fails when the database is not configured", async () => {
    await expect(runAdminCommand(["recovery", "status"], {})).resolves.toBe(1);
    await expect(runAdminCommand(["recovery", "hold-actions"], {})).resolves.toBe(1);
  });

  it("prints usage and fails for an unknown auth subcommand", async () => {
    await expect(runAdminCommand(["auth", "purge"], { DATABASE_URL: "postgres://localhost/mail" })).resolves.toBe(1);
  });

  it("prints usage and fails for the auth group without a subcommand", async () => {
    await expect(runAdminCommand(["auth"], { DATABASE_URL: "postgres://localhost/mail" })).resolves.toBe(1);
  });

  it("rejects extra arguments after a valid command", async () => {
    // A typo after the command used to run the command anyway; the CLI must
    // refuse before it opens the database.
    await expect(
      runAdminCommand(["recovery", "status", "stauts"], {
        DATABASE_URL: "postgres://localhost/mail",
      }),
    ).resolves.toBe(1);
    await expect(
      runAdminCommand(["auth", "bootstrap", "--force"], {
        DATABASE_URL: "postgres://localhost/mail",
      }),
    ).resolves.toBe(1);
  });
});
