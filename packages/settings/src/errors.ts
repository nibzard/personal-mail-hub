/** One settings rejection, mapped onto its HTTP status (SPEC F10). */
export class SettingsError extends Error {
  constructor(
    readonly code: "invalid_request",
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}
