/** One classification rejection, mapped onto its HTTP status (SPEC F8). */
export class ClassificationError extends Error {
  readonly httpStatus: number;

  constructor(
    readonly code: "invalid_request" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ClassificationError";
    this.httpStatus = code === "not_found" ? 404 : 400;
  }
}
