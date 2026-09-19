# Deployment and backup procedures

This directory packages the mail hub for Coolify (SPEC.md section 10): one
multi-stage image, a web gateway, environment checks, volumes, nightly
off-box backups with hash verification, and the restore runbook.

## Shape of the deployment

```
Browser (PWA)
   │  https://mail.example.com
Coolify proxy (terminates TLS)
   │
web gateway (nginx, image target `web`)
   │  serves the built PWA; /api/* → Fastify with the prefix stripped
   │
app container (Node, image target `app`)
   │  Fastify API + worker + drizzle migrations
   │
PostgreSQL (Coolify resource or the db service)
persistent volumes: pgdata, /app/data/storage (durable + cache), /backups
```

One HTTPS origin serves both the client and the API. Session cookies are
same-origin, and the API rejects requests whose `Origin` differs from
`BASE_URL`, so do not split the client and the API across domains.

## Deploy with docker compose

1. Install Docker Engine with the compose plugin, clone this repository, and
   create a scratch database password with `openssl rand -base64 24`.
2. Copy `deploy/env.example` to `deploy/.env`. Fill in
   `POSTGRES_PASSWORD`, `RECOVERY_GENERATION`, `CREDENTIALS_KEY`, and
   `BASE_URL`. For a local trial without TLS, set
   `BASE_URL=http://localhost:8080` and `PREFLIGHT_ALLOW_HTTP=1`.
3. Start the stack: `docker compose -f deploy/docker-compose.yml up -d --build`.
4. Wait for the API to report health:
   `curl http://localhost:8080/api/healthz`.
5. Follow [First installation](#first-installation).

## Deploy on Coolify

The compose file works as a Coolify Docker Compose resource. Create one, point
it at `deploy/docker-compose.yml`, set the variables from `deploy/env.example`
in the resource environment, and assign the public domain (for example
`https://mail.example.com`) to the `web` service. Coolify terminates TLS and
forwards to the gateway on port 8080.

To manage the pieces as separate Coolify resources instead:

1. Create a PostgreSQL resource (or reuse an existing one). Note the major
   version: the app image's `pg_dump` client must be the same or a newer major
   version than the server. The image tracks the Alpine default client, so pin
   the server to the same or an older major. The compose stack pins
   `postgres:16-alpine`.
2. Create an application from this repository with build type Dockerfile and
   Dockerfile target `app`. Do not assign a public domain to it. The default
   `APP_ROLE=all` runs the worker beside the API in one container;
   `APP_ROLE=api` and `APP_ROLE=worker` split them into two resources that
   share the storage volume.
3. Give the app the environment from the table below. Mount one persistent
   volume at `/app/data/storage` and one at `/backups`.
4. Create a second application from the same repository with Dockerfile target
   `web`. Assign the public domain to it. Set its `MAIL_HUB_API_HOST`
   environment variable to the app container's address, for example
   `abc123-app-xyz:3000` from the Coolify container list.
5. Set the app health check to `GET /healthz` on port 3000 when
   `APP_ROLE` is `all` or `api`.
6. Add a scheduled task on the app resource that runs `npm run backup`
   nightly (see [Backups](#backups)).

## Environment reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. The entrypoint applies migrations against it before the server starts. |
| `RECOVERY_GENERATION` | yes | A UUID from deployment configuration. Generate with `uuidgen` at installation, keep it across restarts and releases, and set a new value for every restore. Never recover it from the database or a backup. |
| `CREDENTIALS_KEY` | yes | 32 bytes as base64 or hex. Generate with `openssl rand -base64 32`. Seals stored mailbox passwords. Back it up separately from the database. |
| `BASE_URL` | yes | The deployed HTTPS origin, for example `https://mail.example.com`. Passkey ceremonies and origin checks use it. |
| `HOST` / `PORT` | no | Listener binding. The image defaults to `0.0.0.0:3000`. |
| `STORAGE_ROOT` | no | Object storage root. The image default is `/app/data/storage`. |
| `APP_ROLE` | no | `all` (default), `api`, or `worker`. Only the `api` and `all` roles run migrations. |
| `TYPE_SAFE_API_KEY` | no | Jev classification key. Core mail never waits on it. |
| `SYNC_CYCLE_CRON`, `SEND_CYCLE_CRON`, `SENT_COPY_CYCLE_CRON`, `CLASSIFY_CYCLE_CRON` | no | Worker schedule overrides. Set them only with a valid cron expression; an empty value is not a default. |
| `BACKUP_DIR`, `BACKUP_KEEP` | no | Backup destination (default `/backups`) and retention count (default 14). |
| `PREFLIGHT_ALLOW_HTTP` | no | Set to `1` only for local trials, to accept an `http` `BASE_URL`. |

`deploy/preflight.mjs` checks all of this before the container starts and
fails fast with one message per problem. The checks mirror the parsers the
services use, so a passing preflight means the API opens its routes.

## Volumes

| Mount | Contents | Lossy? |
| --- | --- | --- |
| PostgreSQL data directory | mail data, FTS index, job queues | no |
| `/app/data/storage/durable` | original MIME bytes, uploads, outbound snapshots, with `.meta.json` sidecars | no |
| `/app/data/storage/cache` | extracted attachment copies, derived caches | yes; regenerates from verified originals |
| `/backups` | nightly backup bundles | policy |

Mount `/app/data/storage` as one volume. Only the `durable` subtree needs a
backup; the cache is deliberately excluded and is wiped on restore.

## Health checks

The API exposes `GET /healthz` (no `/api` prefix; the gateway adds it for the
browser). One database round trip gates the report: a failed trip answers
`503`. Every other state answers `200` honestly, including blocked recovery,
so the platform and the operator can watch recovery, sync lag, and queue age.
The `app` image contains a Docker `HEALTHCHECK` on this route; the worker role
has no listener and disables it in the compose file.

## First installation

1. Deploy one of the ways above and confirm the environment checks pass in
   the container logs.
2. Initialize the recovery control state:
   `docker compose -f deploy/docker-compose.yml exec api npm run admin -- recovery init`.
   On Coolify, run the same command in the app container terminal.
3. Print the first-passkey enrollment token:
   `docker compose -f deploy/docker-compose.yml exec api npm run admin -- auth bootstrap`.
   The token prints once and expires after ten minutes.
4. Open `BASE_URL` in the browser and paste the token into the setup form,
   then register the passkey.
5. Add each mailbox under Accounts. The connection test runs per protocol
   before the account saves.
6. Wait for the first sync cycle, then read mail.

## Classification evaluation

Classification stays in shadow mode until the evaluation gate passes (SPEC
section 12). Suggestions never route mail before that.

1. Hand-label 100–200 of your own messages in a JSONL file, one object per
   line: `{"messageId": "<uuid>", "class": "<message class>", "asksAction":
   true}`. Include forwarded chains, bilingual mail, and mixed
   receipt-plus-question mail.
2. Run the measurement inside the app container:

   ```sh
   npm run eval:classify -- --labels /path/to/labels.jsonl
   ```

3. Read the report: critical false negatives (personal or action mail a
   Reading or Notifications bundle would bury), coverage, and correction
   rate per sender.
4. Routing turns on only when the labeled set holds zero critical false
   negatives. The command records the verdict durably; a later failing run
   returns classification to shadow mode. The exit code is 0 only when the
   gate passes.

## Backups

`deploy/backup.sh` runs inside the app container (`npm run backup`):

1. `pg_dump` writes a consistent snapshot in custom format. The snapshot is
   online-safe while the app runs.
2. The durable object tree is copied after the snapshot, so the copy covers
   everything the snapshot references. Objects written later are harmless
   orphans.
3. `deploy/verify-backup.mjs` writes `manifest.sha256` with the hash of every
   file, then re-hashes every file and cross-checks every storage sidecar
   against the copied bytes.
4. Backups older than `BACKUP_KEEP` timestamp directories are removed.

A bundle never contains `CREDENTIALS_KEY` or `RECOVERY_GENERATION`. Store the
key in a password manager or a second secret store. A restore always sets a
new generation.

### Schedule

- Coolify: add a scheduled task to the app resource that runs `npm run backup`
  nightly, for example at 03:07. Mount a host directory at `/backups` so the
  bundles leave the volume.
- Plain compose or host cron:

  ```sh
  7 3 * * * docker compose -f /opt/mail-hub/deploy/docker-compose.yml run --rm api npm run backup
  17 3 * * * rsync -a --delete /srv/mail-hub-backups/ backup-host::mail-hub/
  ```

  Point `BACKUP_DIR` or a bind mount at `/srv/mail-hub-backups` first. Copy
  the bundles off the box with `rsync`, `rclone`, or an equivalent tool; an
  off-box copy is the point of the procedure.

### Rehearse

Rehearse the full restore before you depend on it (SPEC.md section 10):

1. The automated rehearsal is `apps/api/test/restore-acceptance.test.ts`,
   which runs a backup, loses the live database, and walks the recovery.
2. Rehearse manually on a scratch stack: deploy with compose on a spare host,
   back up, then follow [Restore](#restore) against it end to end.

## Restore

`deploy/restore.sh` verifies the bundle, restores the database, and puts the
durable objects back. The recovery commands after it are what make the
restored deployment safe; a database restore alone never enables normal
operation.

1. Stop the API and the worker. Make sure the old process cannot continue a
   remote operation. Preserve any receipts newer than the backup.
2. Run the restore against the stack's database:

   ```sh
   docker compose -f deploy/docker-compose.yml run --rm api \
     sh /app/deploy/restore.sh /backups/20260919T030000Z --yes
   ```

   Without `--yes` the script verifies the bundle and prints the plan only.
3. Set a new `RECOVERY_GENERATION` in the deployment environment and start
   the app. Workers and mail mutations stay blocked until recovery completes.
4. In the app container, run `npm run admin -- recovery begin`, then
   `npm run admin -- recovery hold-actions`. The first command records the
   new generation, revokes restored sessions and credentials, and disables
   old jobs. The second dispositions restored actions: old queued items
   become conflicted, old executing items unknown.
5. Review restored pending sends and uncertain outcomes in the review flow.
   Keep unresolved sends at `outcome unknown`. Never auto-resend; a deliberate
   resend needs the duplicate warning, a new key, and a new snapshot.
6. Run `npm run admin -- auth recover`, register the replacement passkey from
   its one-time token, and verify you can sign in and inspect held work.
7. Run `npm run admin -- recovery complete`. It requires a registered owner,
   the matching deployment generation, and disposition of all restored
   pending operations. Normal work reopens; old jobs stay disabled.

## Upgrades and releases

1. Redeploy from the new revision. The entrypoint applies migrations before
   the server starts.
2. Keep `RECOVERY_GENERATION` and `CREDENTIALS_KEY` unchanged across ordinary
   releases. Only a restore changes the generation.
3. Run `npm run release:gate` with `TEST_DATABASE_URL` set before cutting a
   release, and pass `--strict` for the release mode.

## Resource sizing

- 2 GB RAM instance. One IMAP connection per account during backfill.
- Watch free disk space. Pause imports and uploads before durable writes
  become unsafe.
- The app image carries development dependencies (`tsx`, `drizzle-kit`)
  because it runs TypeScript from source; size the disk accordingly.

## Verification checklist

- `docker compose -f deploy/docker-compose.yml ps` reports `db`, `api`,
  `worker`, and `web` healthy or running.
- `curl https://mail.example.com/api/healthz` answers `200` with the recovery
  state, sync lag, and queue age.
- `ls /backups/<latest>` shows `database.pgdump`, `database.catalog`,
  `storage-durable/`, `manifest.sha256`, and `BACKUP-INFO.txt`.
- `docker compose ... run --rm api node deploy/verify-backup.mjs --check
  /backups/<latest>` reports every file hashed and every sidecar cross-checked.
