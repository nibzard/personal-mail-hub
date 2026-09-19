# json-render: experimental composition with Jev

Checked September 18, 2026. Repository: [vercel-labs/json-render](https://github.com/vercel-labs/json-render).
Source snapshot: [`3ad3818`](https://github.com/vercel-labs/json-render/tree/3ad381881194e7011ad3ccd6d668033495a06c29).

Both application programming interfaces (APIs) are exported by
`@json-render/core@0.21.0`. This was verified in the published package's type
declarations and runtime bundle. The guide still labels them unreleased, so
its release status appears stale. Pin exact package versions because these
experimental APIs can change in any release.
[Published package](https://registry.npmjs.org/@json-render/core/-/core-0.21.0.tgz),
[official guide](https://json-render.dev/docs/jev).

## `experimental_composeSpec`

This asynchronous generator builds a user interface (UI) specification from
choices supplied by the application. Required inputs are `catalog`,
`candidates`, `prompt`, and `evaluate`. Each candidate contains a component
type, concrete properties, and optional state or action bindings. The evaluator
selects elements and their placement. The application supplies the content.
[Composer source](https://github.com/vercel-labs/json-render/blob/3ad381881194e7011ad3ccd6d668033495a06c29/packages/core/src/experimental-compose.ts).

- New trees use batched composition by default. `strategy: "sequential"`
  selects individual operations.
- `initialSpec` enables sequential edits, including replacement, removal,
  movement, and reordering.
- `step` events contain complete `Spec` snapshots. The final `complete` event
  includes the specification, steps, timing, token usage, and `stopReason`.
- Stop reasons are `finish`, `limit`, and `unavailable`. The result can be
  partial or `null`. Invalid inputs, provider errors, and cancellation throw.
- `maxSteps` limits evaluations. `maxElements` limits batched creation.
  `maxDepth` limits tree depth. `signal` supports cancellation.
- The composer validates the structure and bindings. It never executes actions.

These behaviors come from the
[composer implementation](https://github.com/vercel-labs/json-render/blob/3ad381881194e7011ad3ccd6d668033495a06c29/packages/core/src/experimental-compose.ts).

## `experimental_createEvaluator`

This factory creates the choice evaluator that `experimental_composeSpec`
calls. It sends state and choice questions through Vercel AI Gateway's
experimental version 4 evaluation endpoint. It checks that each returned
answer matches an offered choice. Results can include confidence and input
token usage.
[Evaluator source](https://github.com/vercel-labs/json-render/blob/3ad381881194e7011ad3ccd6d668033495a06c29/packages/core/src/experimental-evaluator.ts).

Required options are `apiKey` and `model`. The documented Jev model is
`typesafe-ai/jev`. Optional settings are `timeoutMs`, which defaults to 10,000
milliseconds per evaluation, and a custom `fetch`. Keep the evaluator and
key on the server. Set an overall composition deadline through `signal`.
[Evaluator source](https://github.com/vercel-labs/json-render/blob/3ad381881194e7011ad3ccd6d668033495a06c29/packages/core/src/experimental-evaluator.ts).

The guide uses `AI_GATEWAY_API_KEY` and requires Gateway access to the
`typesafe-ai` provider. A separate TypeSafe key is unnecessary for this route.
The composer also accepts a custom evaluator that implements its choice
contract. [Official guide](https://json-render.dev/docs/jev).

## Integration limits

Composition uses json-render's flat `Spec` format. Supported expressions
include literals, `$state`, `$bindState`, and state-based visibility.
Repeats, watches, computed values, templates, and custom directives are
outside this initial subset. Snapshots replace the full specification;
disable interaction during composition to prevent overwritten edits.
[Official guide](https://json-render.dev/docs/jev).

The composer keeps `initialState` out of evaluator requests. Prompts,
descriptions, and explicit `context` are shared. Validation uses the initial
state and does not apply schema defaults or transforms. Validate current
values and authorize actions when they run. A `finish` result does not prove
that the interface meets the user's request.
[Official guide](https://json-render.dev/docs/jev).

## Possible use in this email product

Proposal: test a read-only triage summary made from fixed cards for Needs
action, Waiting, and Later. Let Jev select and arrange those cards. Supply
counts and message data through state bindings. Use generic descriptions and
share only the context needed to choose the layout.

Compare the result with a fixed layout. Measure task completion, latency,
evaluation cost, and incomplete results. Keep the fixed layout as a fallback.

This would add an optional interface experiment to the current
[specification](../SPEC.md). The existing Jev classification plan uses the
TypeSafe service directly with `TYPE_SAFE_API_KEY`. The Gateway evaluator
introduces a separate integration route. Researching these APIs does not
change the current build scope.
