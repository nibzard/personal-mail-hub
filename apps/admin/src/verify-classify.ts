import {
  JEV_MODEL,
  QUESTION_SET_VERSION,
  jevAdapterFromEnv,
  type JevAdapter,
  type JevAdapterEnvironment,
  type JevDecision,
} from "@mail-hub/classification";

/**
 * The synthetic classification smoke check (T108):
 *
 *   npm run verify:classify
 *
 * One call to the configured Jev service over invented text. The command
 * proves the deployed adapter talks to the documented endpoint with the
 * pinned model and parses a typed answer. It sends no mail, writes no
 * database, and prints only approved fields: never the API key, never the
 * raw response, never real message text — the probe text below is invented.
 *
 * Missing credentials are an explicit unverified result, not an error. Run
 * this after deployment and whenever the adapter, the question set, the
 * model, or the endpoint changes.
 */

const USAGE = `Usage: npm run verify:classify

Calls the configured Jev classification service once with invented text.
Set TYPE_SAFE_API_KEY in the environment; JEV_API_BASE_URL and
JEV_TIMEOUT_MS are optional overrides. The exit code is 0 only when the
call returns a parsed decision from the pinned model.
`;

/**
 * Invented probe text. It states no fact about any person and names no real
 * address, so the call carries no mail data in either direction.
 */
const SYNTHETIC_TEXT = [
  "From: sender@example.net",
  "Subject: Synthetic verification message",
  "",
  "This text is invented for a service check. It contains no personal data",
  "and requests no action. It exists so one call can prove the endpoint,",
  "the model version, and the answer format.",
].join("\n");

/** Where the command writes. Injectable so tests capture output. */
export interface VerifyClassifyIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

const STANDARD_IO: VerifyClassifyIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Builds the adapter from the environment; injectable for tests. */
type AdapterFactory = (env: JevAdapterEnvironment) => JevAdapter | null;

const standardAdapterFactory: AdapterFactory = (env) => jevAdapterFromEnv(env);

/** Run one smoke check. Returns the process exit code. */
export async function runVerifyClassify(
  args: string[],
  env: JevAdapterEnvironment = process.env,
  io: VerifyClassifyIO = STANDARD_IO,
  buildAdapter: AdapterFactory = standardAdapterFactory,
): Promise<number> {
  if (args.length > 0) {
    io.stdout(USAGE);
    return 1;
  }

  const adapter = buildAdapter(env);
  if (adapter === null) {
    io.stdout("classify-smoke: UNVERIFIED — TYPE_SAFE_API_KEY is not set; the service was not called.\n");
    return 1;
  }

  io.stdout(
    `classify-smoke: model=${JEV_MODEL} questions=${QUESTION_SET_VERSION} calls=1 text=synthetic\n`,
  );

  let decision: JevDecision;
  try {
    decision = await adapter.ask({ text: SYNTHETIC_TEXT });
  } catch (error) {
    // Adapter errors carry a kind and a fixed message; they never hold the
    // key, the raw response, or message text.
    const kind = (error as { kind?: string }).kind ?? "error";
    const message = error instanceof Error ? error.message : "unknown failure";
    io.stdout(`classify-smoke: FAILED (${kind}) — ${message}\n`);
    return 1;
  }

  if (decision.model !== JEV_MODEL) {
    io.stdout(`classify-smoke: FAILED (model_mismatch) — the service reported ${decision.model}.\n`);
    return 1;
  }

  io.stdout(
    [
      `classify-smoke: ok model=${decision.model} questions=${QUESTION_SET_VERSION}`,
      `answers: class=${decision.answers.classHint} sender=${decision.answers.senderRelationship}`,
      `asksAction=${decision.answers.asksAction} (${decision.confidence.asksAction ?? "?"})`,
      `asksReply=${decision.answers.asksReply} timeSensitive=${decision.answers.timeSensitive}`,
      `latencyMs=${decision.latencyMs} inputTokens=${decision.inputTokens ?? "not reported"}`,
      "classify-smoke: VERIFIED — the configured service answered the documented contract.",
    ].join(" ").concat("\n"),
  );
  return 0;
}

const invokedAsScript = process.argv[1] !== undefined && process.argv[1].endsWith("verify-classify.ts");
if (invokedAsScript) {
  process.exit(await runVerifyClassify(process.argv.slice(2)));
}
