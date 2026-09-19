import {
  MESSAGE_CLASSES,
  SENDER_RELATIONSHIPS,
  type MessageClass,
  type SenderRelationship,
} from "@mail-hub/contracts";

/**
 * The Jev adapter over the TypeSafe API (SPEC F8).
 *
 * Jev answers bounded questions; it never generates text. One call carries
 * the whole question set for one message, so the cost model stays one call
 * per message. The model version is pinned because `jev-latest` moves and
 * thresholds need stable behavior. This adapter is the only module that
 * knows the wire format, so an API change is a change here and a bump of
 * the pinned version together.
 */

/** The pinned Jev model. Change it only with a threshold review (SPEC F8). */
export const JEV_MODEL = "typesafe-ai/jev@2026-09-15";

/** Identifies the exact question set one decision was asked (SPEC F8). */
export const QUESTION_SET_VERSION = "classify-1";

/** The TypeSafe API origin. Overridable so tests never leave the machine. */
export const DEFAULT_JEV_API_BASE_URL = "https://api.typesafe.ai";

/** One evaluation timeout. Research reports 70–500 ms answers; allow headroom. */
export const DEFAULT_JEV_TIMEOUT_MS = 10_000;

const MESSAGE_CLASS_SET: ReadonlySet<string> = new Set(MESSAGE_CLASSES);
const SENDER_RELATIONSHIP_SET: ReadonlySet<string> = new Set(SENDER_RELATIONSHIPS);

/** The bounded answers one Jev call returns (SPEC F8 question set). */
export interface JevAnswers {
  classHint: MessageClass;
  senderRelationship: SenderRelationship;
  asksAction: boolean;
  asksReply: boolean;
  timeSensitive: boolean;
}

/** The confidence Jev reported per answer, between 0 and 1, when it did. */
export interface JevConfidence {
  classHint: number | null;
  senderRelationship: number | null;
  asksAction: number | null;
  asksReply: number | null;
  timeSensitive: number | null;
}

/** One successful Jev evaluation. */
export interface JevDecision {
  /** The model that answered, as reported back. */
  model: string;
  answers: JevAnswers;
  confidence: JevConfidence;
  /** Whole milliseconds the call took. */
  latencyMs: number;
  /** Reported input tokens, when the service counted them. */
  inputTokens: number | null;
}

/** How one adapter call failed. The circuit breaker counts all of them. */
export type JevFailureKind = "timeout" | "request_failed" | "invalid_response";

/** One adapter failure, with the kind the circuit breaker and audit need. */
export class JevAdapterError extends Error {
  constructor(
    readonly kind: JevFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "JevAdapterError";
  }
}

/** The adapter surface the classification service needs. */
export interface JevAdapter {
  /** Ask the whole question set over one minimized message text. */
  ask(input: { text: string }): Promise<JevDecision>;
}

export interface TypeSafeJevAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable transport; tests stub it instead of opening sockets. */
  fetch?: typeof fetch;
}

/** One choice question of the set, as the request carries it. */
interface ChoiceQuestion {
  id: "class_hint" | "sender_relationship";
  kind: "choice";
  choices: string[];
}

/** One yes/no question of the set, as the request carries it. */
interface BooleanQuestion {
  id: "asks_action" | "asks_reply" | "time_sensitive";
  kind: "boolean";
}

/** The question set every call sends, in one fixed order. */
const QUESTIONS: (ChoiceQuestion | BooleanQuestion)[] = [
  { id: "class_hint", kind: "choice", choices: [...MESSAGE_CLASSES] },
  { id: "sender_relationship", kind: "choice", choices: [...SENDER_RELATIONSHIPS] },
  { id: "asks_action", kind: "boolean" },
  { id: "asks_reply", kind: "boolean" },
  { id: "time_sensitive", kind: "boolean" },
];

/**
 * The pinned-model adapter. Every failure leaves as a `JevAdapterError`, so
 * callers never see a transport detail and no message text reaches an error.
 */
export class TypeSafeJevAdapter implements JevAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;

  constructor(options: TypeSafeJevAdapterOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new JevAdapterError("request_failed", "The TypeSafe API key is empty.");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_JEV_API_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS;
    this.transport = options.fetch ?? fetch;
  }

  async ask(input: { text: string }): Promise<JevDecision> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.transport(`${this.baseUrl}/v1/evaluations`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: JEV_MODEL,
          input: { text: input.text },
          questions: QUESTIONS,
        }),
      });
    } catch (cause) {
      if (cause instanceof JevAdapterError) {
        throw cause;
      }
      if (cause instanceof Error && cause.name === "AbortError") {
        throw new JevAdapterError("timeout", `Jev did not answer within ${this.timeoutMs} ms.`);
      }
      throw new JevAdapterError("request_failed", "The Jev evaluation request could not be sent.");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new JevAdapterError(
        "request_failed",
        `The Jev evaluation endpoint answered with HTTP ${response.status}.`,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new JevAdapterError("invalid_response", "The Jev evaluation response was not JSON.");
    }
    const latencyMs = Date.now() - startedAt;
    return parseEvaluation(payload, latencyMs);
  }
}

/** Shape one TypeSafe evaluation response takes. */
interface EvaluationResponse {
  model?: unknown;
  answers?: unknown;
  confidence?: unknown;
  usage?: unknown;
}

/**
 * Validate one response into a decision. Anything out of bounds is an
 * `invalid_response` failure: a guessed answer is worse than a retry.
 */
function parseEvaluation(payload: unknown, latencyMs: number): JevDecision {
  if (!isRecord(payload)) {
    throw new JevAdapterError("invalid_response", "The Jev evaluation response held no object.");
  }
  const body = payload as EvaluationResponse;
  const answers = isRecord(body.answers) ? body.answers : null;
  if (answers === null) {
    throw new JevAdapterError("invalid_response", "The Jev evaluation response named no answers.");
  }
  const classHint = classOf(answers.class_hint);
  const senderRelationship = relationshipOf(answers.sender_relationship);
  const asksAction = booleanOf(answers.asks_action);
  const asksReply = booleanOf(answers.asks_reply);
  const timeSensitive = booleanOf(answers.time_sensitive);

  const confidenceBody = isRecord(body.confidence) ? body.confidence : {};
  const usage = isRecord(body.usage) ? body.usage : {};
  const inputTokens =
    typeof usage.inputTokens === "number" && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
      ? usage.inputTokens
      : null;

  return {
    model: typeof body.model === "string" && body.model.length > 0 ? body.model : JEV_MODEL,
    answers: { classHint, senderRelationship, asksAction, asksReply, timeSensitive },
    confidence: {
      classHint: confidenceOf(confidenceBody.class_hint),
      senderRelationship: confidenceOf(confidenceBody.sender_relationship),
      asksAction: confidenceOf(confidenceBody.asks_action),
      asksReply: confidenceOf(confidenceBody.asks_reply),
      timeSensitive: confidenceOf(confidenceBody.time_sensitive),
    },
    latencyMs,
    inputTokens,
  };
}

function classOf(value: unknown): MessageClass {
  if (typeof value === "string" && MESSAGE_CLASS_SET.has(value)) {
    return value as MessageClass;
  }
  throw new JevAdapterError("invalid_response", "Jev named a message class outside the offered set.");
}

function relationshipOf(value: unknown): SenderRelationship {
  if (typeof value === "string" && SENDER_RELATIONSHIP_SET.has(value)) {
    return value as SenderRelationship;
  }
  throw new JevAdapterError(
    "invalid_response",
    "Jev named a sender relationship outside the offered set.",
  );
}

function booleanOf(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new JevAdapterError("invalid_response", "A yes/no Jev answer was not a boolean.");
}

function confidenceOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface JevAdapterEnvironment {
  TYPE_SAFE_API_KEY?: string | undefined;
  JEV_API_BASE_URL?: string | undefined;
  JEV_TIMEOUT_MS?: string | undefined;
}

/**
 * The adapter deployment configuration names, or `null` when classification
 * stays unconfigured. Core mail never waits on the result either way (SPEC
 * product principle 1).
 */
export function jevAdapterFromEnv(env: JevAdapterEnvironment): JevAdapter | null {
  const apiKey = env.TYPE_SAFE_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return null;
  }
  const timeoutMs = parseTimeout(env.JEV_TIMEOUT_MS);
  return new TypeSafeJevAdapter({
    apiKey,
    baseUrl: env.JEV_API_BASE_URL,
    timeoutMs: timeoutMs ?? undefined,
  });
}

function parseTimeout(value: string | undefined): number | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 120_000 ? parsed : null;
}
