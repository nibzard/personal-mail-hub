import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The image installs dependencies from manifests alone (Dockerfile): every
 * workspace manifest is COPYed before `RUN npm ci`, then `COPY . .` brings
 * the source. The root manifest globs apps/* and packages/*, so a workspace
 * whose manifest is not copied simply does not exist when npm ci compares
 * the lockfile against the tree, and the image build fails with an error
 * that names no missing file. This test fails first, naming the workspace.
 */

const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");

/** Every workspace directory the root globs resolve to, sorted. */
function workspaceDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ["apps", "packages"]) {
    const entries = readdirSync(new URL(`../../../${group}`, import.meta.url), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const dir = `${group}/${entry.name}`;
      if (entry.isDirectory() && existsSync(new URL(`../../../${dir}/package.json`, import.meta.url))) {
        dirs.push(dir);
      }
    }
  }
  return dirs.sort();
}

describe("image dependency layers", () => {
  it("copies every workspace manifest before npm ci in each stage", () => {
    const workspaces = workspaceDirs();
    expect(workspaces.length).toBeGreaterThan(10);

    const stages = dockerfile.split(/^FROM /m).slice(1);
    const installing = stages.filter((stage) => stage.includes("RUN npm ci"));
    // Both the web-build stage and the app stage install this way.
    expect(installing).toHaveLength(2);

    for (const stage of installing) {
      const name = stage.match(/^[\w:-]+ AS (\w+)/)?.[1] ?? "(unnamed stage)";
      const beforeInstall = stage.split("RUN npm ci")[0]!;
      for (const dir of workspaces) {
        expect(beforeInstall, `${name} is missing ${dir}/package.json`).toContain(
          `COPY ${dir}/package.json`,
        );
      }
    }
  });
});
