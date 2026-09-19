# Personal mail hub development

## Modules

- `apps/web` contains the React client.
- `apps/api` contains HTTP routes and application services.
- `apps/worker` contains background job entry points.
- `apps/admin` contains the operator command line (`npm run admin -- ...`).
- `packages/contracts` contains shared API contracts.
- `packages/auth` contains passkey authentication: enrollment grants,
  WebAuthn ceremonies, owner sessions, and the `auth` admin commands.
- `packages/accounts` contains account and identity management: the
  AES-256-GCM credential cipher, folder discovery imports, role mapping,
  and send identities.
- `packages/recovery` contains the recovery control state, the mutation
  generation gate, and the operator recovery commands.
- `packages/transport` contains the verified IMAP and SMTP connection tests.
  Both protocols require validated TLS; credentials are only sent after the
  encrypted connection is verified.
- `packages/database` contains the Drizzle schema, SQL migrations, object
  storage, and pg-boss integration. Run `npm run db:generate` there after
  changing `src/schema.ts`; apply migrations with `npm run db:migrate`.

## Commands

1. Run `npm install` after you change dependencies.
2. Run `npm run check` before you commit TypeScript changes.
3. Run `npm test` before you commit behavior changes.
4. Run `npm run db:migrate` with `DATABASE_URL` set to apply migrations. The
   migration test suite needs `TEST_DATABASE_URL` and skips without it.
5. Run `npm run admin -- recovery status` to inspect the recovery control
   state. Use `recovery init` on a fresh installation and `recovery begin`
   plus `recovery complete` after a restore.
6. Run `npm run admin -- auth bootstrap` on a fresh installation to print the
   first-passkey enrollment token, and `npm run admin -- auth recover` after
   all passkeys are lost. Set `BASE_URL` to the deployed origin first; the
   token prints once and only its hash is stored.

## Rules

- Keep mailbox credentials out of browser code and logs.
- Keep enrollment tokens and session tokens out of logs and URLs; store only
  their hashes.
- Validate every HTTP input at the API boundary.
- Use application services for mutations. Do not let routes or workers bypass them.
- Keep the provider mailbox state, application work state, and agent state separate.
- Check the recovery generation before the idempotency lookup in every
  mutation service. Reject an old generation with `409 recovery_required`.
- Workers stay blocked unless the deployment and database recovery state
  match with mode `ready`. A job keeps the generation it was created with;
  a lease renewal or queue retry never upgrades it.
