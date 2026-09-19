/**
 * Jev classification in shadow mode (SPEC F8), its corrections, and the
 * evaluation gate that owns the routing verdict (SPEC section 12).
 *
 * A pinned-model adapter over the TypeSafe API, minimized message input,
 * deterministic precedence with Jev as the residual, decisions storage, a
 * circuit breaker, and a monthly cost cap. Every answer is a visible
 * suggestion; nothing routes mail until a labeled evaluation measures zero
 * critical false negatives.
 */
export {
  DEFAULT_JEV_API_BASE_URL,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_MODEL,
  QUESTION_SET_VERSION,
  TypeSafeJevAdapter,
  jevAdapterFromEnv,
  type JevAdapter,
  type JevAdapterEnvironment,
  type JevAdapterError,
  type JevAnswers,
  type JevConfidence,
  type JevDecision,
  type JevFailureKind,
} from "./adapter.ts";
export {
  CLASS_CORRECTED_EVENT,
  CorrectionService,
  type CorrectionContext,
  type CorrectionRequest,
  type CorrectionResult,
} from "./corrections.ts";
export { ClassificationError } from "./errors.ts";
export {
  ASKS_ACTION_BREAKOUT_CONFIDENCE,
  CLASS_GATE_EVENT,
  MINIMUM_LABELED_MESSAGES,
  evaluateClassification,
  parseClassificationLabels,
  readRoutingState,
  recordClassificationGate,
  type ClassificationEvaluation,
  type ClassificationLabel,
  type CriticalFalseNegative,
  type RoutingGateState,
  type RoutingGateVerdict,
  type SenderCorrectionRate,
} from "./evaluation.ts";
export { MAX_INPUT_CHARS, minimizeMessageInput, stripQuotedChains, type MessageInputSource, type MinimizedMessageInput } from "./input.ts";
export { matchDeterministicRules, type DeterministicRuleMatch, type RuleInput } from "./rules.ts";
export {
  CLASS_ERROR_EVENT,
  CLASS_SESSION_EVENT,
  CIRCUIT_COOLDOWN_MS,
  CIRCUIT_ERROR_THRESHOLD,
  CIRCUIT_WINDOW_MS,
  ClassificationService,
  DEFAULT_CLASSIFY_BATCH_LIMIT,
  ESTIMATED_COST_PER_CALL_USD,
  ESTIMATED_INPUT_TOKENS_PER_CALL,
  PRICE_PER_MILLION_INPUT_TOKENS_USD,
  type ClassifyCycleSummary,
  type ClassifyMessageOutcome,
  type CircuitState,
  type CycleSkipReason,
  type SettingsReader,
} from "./service.ts";
