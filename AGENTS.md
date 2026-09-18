# Personal mail hub development

## Modules

- `apps/web` contains the React client.
- `apps/api` contains HTTP routes and application services.
- `apps/worker` contains background job entry points.
- `packages/contracts` contains shared API contracts.
- `packages/database` contains Drizzle and pg-boss integration.

## Commands

1. Run `npm install` after you change dependencies.
2. Run `npm run check` before you commit TypeScript changes.
3. Run `npm test` before you commit behavior changes.

## Rules

- Keep mailbox credentials out of browser code and logs.
- Validate every HTTP input at the API boundary.
- Use application services for mutations. Do not let routes or workers bypass them.
- Keep the provider mailbox state, application work state, and agent state separate.
