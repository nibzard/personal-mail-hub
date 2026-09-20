import type { HomeErrorCode } from "@mail-hub/contracts";

/** One Home rejection, mapped onto its HTTP status (SPEC F13). */
export class HomeError extends Error {
  /** The revision the server holds, when the refusal was a stale revision. */
  readonly currentRevision?: number;

  constructor(
    readonly code: HomeErrorCode,
    message: string,
    readonly httpStatus = 400,
    currentRevision?: number,
  ) {
    super(message);
    this.name = "HomeError";
    this.currentRevision = currentRevision;
  }
}
