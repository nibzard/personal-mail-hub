/**
 * Declarations for the build fingerprint module (T112), for its
 * TypeScript importers; the module itself stays plain JavaScript.
 */

/**
 * One sha256 over every file's relative path and bytes below
 * `directory`, sorted by path: equal trees hash equal, any changed byte
 * changes the result. Throws when the directory holds no files.
 */
export declare function fingerprintDir(directory: string): Promise<string>;
