/*
 * Run-directory retirement shared by the Playwright config and the fixture
 * launcher (T112). A run names its directories after the pid of the
 * process that led the run, so any later process can tell a live run's
 * directories from an abandoned one's: a directory that names a dead pid
 * is garbage, whatever clock says.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/** True when a process with this pid answers a signal probe. */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but another user owns it. ESRCH: no such
    // process. Anything else (bad pid, permissions) reads as alive, which
    // only keeps a directory longer — never deletes a live run's.
    return error.code !== "ESRCH";
  }
}

/**
 * Removes every `<prefix><pid>-…` directory under `root` whose pid no
 * longer runs. A live run keeps its directories however long it runs;
 * names without a leading pid after the prefix are not this scheme's and
 * stay untouched.
 */
export async function sweepAbandonedDirs(root, prefix) {
  let entries;
  try {
    entries = await readdir(root);
  } catch {
    return; // Nothing here has ever been named after a run.
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const pid = Number.parseInt(name.slice(prefix.length), 10);
        if (!Number.isInteger(pid) || pid <= 0 || isProcessAlive(pid)) {
          return;
        }
        await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
      }),
  );
}
