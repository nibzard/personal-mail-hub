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
  });
});
