/**
 * Declarations for the run-isolation module (T112), for its TypeScript
 * importer (the Playwright config); the module itself stays plain
 * JavaScript.
 */

/** True when a process with this pid answers a signal probe. */
export declare function isProcessAlive(pid: number): boolean;

/**
 * Removes every `<prefix><pid>-…` directory under `root` whose pid no
 * longer runs. A live run keeps its directories however long it runs.
 */
export declare function sweepAbandonedDirs(root: string, prefix: string): Promise<void>;
