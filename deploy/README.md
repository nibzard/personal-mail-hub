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

## Operator access

Deployment work happens over SSH from an authorized workstation. Confirm the
access with one command before any procedure in this runbook:

```sh
npm run deploy:access
```

The command is read-only. It prints one line per capability and names the
missing capability on failure. It never prints token values, environment
variables, or key material, and it generates no credentials. It checks the
operator side; `deploy/preflight.mjs` stays the check for the container
environment.

### Access facts

| Fact | Value |
| --- | --- |
| Repository | `https://github.com/nibzard/personal-mail-hub` |
| Branch | `main` |
| Compose file | `deploy/docker-compose.yml`; the Coolify variant is `deploy/docker-compose.coolify.yml` |
| Pilot host | SSH alias `awc-pilot` in `~/.ssh/config`: user `debian`, address `192.168.1.144` on the LAN |
| Dedicated identity | `~/.ssh/id_ed25519_awc_pilot` |
| Application URL | Fill in: the public domain assigned in the Coolify console to the `web` service. Record it as `DEPLOY_APP_URL` in `deploy/access.env`. |
| Coolify base URL | Fill in: the console origin, for example `https://coolify.example.com`. Record it as `DEPLOY_COOLIFY_URL`. |
| Coolify resource | Fill in: open the resource in the console and copy the UUID from its URL. |
| Tailnet host | Fill in: run `tailscale status`. If the pilot joined the tailnet, its name and `100.x` address appear there; use them as the `HostName` when the LAN route is down. On 2026-09-20 the tailnet listed no peer for the pilot, so the LAN address is the only known route. |

Record the application URL and the Coolify URL in `deploy/access.env` (copy
`deploy/access.env.example`); git ignores that file. Keep the Coolify
resource UUID in your deployment records; the check does not need it.

### Set up a fresh workstation

1. Create the SSH entry in `~/.ssh/config`:

   ```ssh-config
   Host awc-pilot
       HostName 192.168.1.144
       User debian
       IdentityFile ~/.ssh/id_ed25519_awc_pilot
       IdentitiesOnly yes
       StrictHostKeyChecking accept-new
       ConnectTimeout 8
       ServerAliveInterval 30
   ```

2. Transfer the dedicated identity from its secret store and lock it down:
   `install -m 600 <key-file> ~/.ssh/id_ed25519_awc_pilot`. The private key
   never lives in this repository.
3. Copy `deploy/access.env.example` to `deploy/access.env` and fill in the
   Coolify and application URL lines.
4. Run `npm run deploy:access`. Every required line reads `ok`.

### What the check confirms

| Line | Confirms | Required | Failure categories |
| --- | --- | --- | --- |
| `identity` | The identity file exists and is readable | yes | `identity_unreadable` |
| `ssh` | Route, host key, and key authentication | yes | `hostname_unresolved`, `host_key_mismatch`, `network_unreachable`, `connection_refused`, `identity_unreadable`, `ssh_auth_denied`, `ssh_failed` (unmapped; read the detail line) |
| `docker` | Docker control over SSH | yes | `docker_missing`, `docker_forbidden`, `docker_daemon_unreachable`, `docker_unavailable` (unmapped) |
| `coolify` | The configured Coolify API token works | when configured | `coolify_token_rejected`, `coolify_unexpected_status`, `coolify_unreachable` |
| `app` | The deployed health endpoint answers | when configured | `app_database_unavailable`, `app_unhealthy`, `app_unreachable` |

The exit code is `0` only when the required lines and every configured
optional line pass. An unconfigured optional line reports `not configured`
and never fails the run. For machine-readable output, run
`npm run deploy:access -- --json`; npm needs the `--` so the flag reaches
the script instead of npm. A configured value that starts with `-` fails
the run as `unsafe_operand` before anything connects.

### Host-key verification

`accept-new` trusts the first connection. Verify the host key beyond that:

1. From the workstation, read the fingerprint the network path presents
   (the scan itself runs over the same untrusted path, so it proves nothing
   alone):

   ```sh
   ssh-keyscan -t ed25519 192.168.1.144 | ssh-keygen -lf -
   ```

2. On a channel you already trust — the pilot console — compare it with the
   fingerprint the pilot reports
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the pilot).
3. Pin the verified key as the only entry for the host. Remove whatever the
   first `accept-new` connection wrote, then append:

   ```sh
   ssh-keygen -R 192.168.1.144
   ssh-keyscan -t ed25519 -H 192.168.1.144 >> ~/.ssh/known_hosts
   ```

   Set `StrictHostKeyChecking yes` for the host. An impostor key that
   `accept-new` already recorded stays trusted until you remove it, because
   ssh accepts a key that matches any known entry.

A later `host_key_mismatch` failure means the key changed. Confirm the host
was rebuilt or replaced on purpose before you remove the old entry with
`ssh-keygen -R 192.168.1.144` and re-enroll. An unexplained change means
possible interception; stop and investigate.

### Public-key enrollment

1. Print the public key of the dedicated identity:
   `ssh-keygen -y -f ~/.ssh/id_ed25519_awc_pilot`.
2. On the pilot, append that one line to
   `/home/debian/.ssh/authorized_keys` (mode `600`, owned by `debian`).
3. Re-run `npm run deploy:access`; the `ssh` line reads `ok`.

### Rotation

Rotate only for a reason: a lost workstation, a suspected compromise, or an
operator change. Do not rotate working credentials during a routine deploy.

1. Generate a new pair:
   `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_awc_pilot_2 -C "mail-hub deploy"`.
2. Enroll the new public key beside the old one (see above), then point the
   SSH entry's `IdentityFile` at the new file.
3. Confirm `npm run deploy:access` passes, store the new private key in the
   secret store, then revoke the old key (below).

### Revocation

1. On the pilot, remove the old public-key line from
   `/home/debian/.ssh/authorized_keys`.
2. Remove the workstation copy: `rm ~/.ssh/id_ed25519_awc_pilot`.
3. Run `npm run deploy:access` from a workstation that still carried the old
   key. It must fail with `ssh_auth_denied`; that failure proves the
   revocation works.

## Verify a deployment

One read-only command answers whether the deployment works, not just
whether its containers are healthy:

```sh
npm run deploy:verify
```

The command reads three evidence sources, each optional and classified
when unavailable: Docker (locally, or over SSH when `DEPLOY_SSH_HOST` is
set) for containers, restarts, and the deployed revision; the public
health endpoint at `DEPLOY_APP_URL` for recovery state, per-account sync
states, and send counters; and narrow aggregate queries through psql in
the database container for folder-backfill and classification progress.
It never sends or mutates mail. Output holds states, counts, timestamps,
UUIDs, and image names only — never folder names, addresses, message
content, raw logs, or secrets.

The verdict is one of:

- `VERIFIED` — every required check ran and passed. Untested areas are
  listed, for example sync workflows when no account is enrolled.
- `FAILED` — a check proved a problem: pending work that did not move
  between two samples, an account reporting sync failures or a stale sync
  record, a wrong revision, a container that is not running, unhealthy,
  paused, or restart-looping, or a failed
  database round trip.
- `UNVERIFIED` — a required check could not run: no Docker access,
  missing privileges, no containers found, or an observation timeout. A
  partial picture is never reported as verified.

Progress needs two samples. Pass an interval in seconds; the command then
decides per account whether pending work is moving, idle, or stalled:

```sh
npm run deploy:verify -- --sample-interval 30 --expect-revision <tag-or-sha>
```

An idle mailbox is never a failure: progress is judged only where work is
pending. `--expect-revision` fails the run when the deployed image does
not match; it accepts a tag, a digest (`sha256:...`), or a revision label,
and without it the revision is reported but not judged. `-- --json` prints
the machine-readable result (npm needs the `--`; add `--silent` or call
`node deploy/verify-deployment.mjs --json` when you pipe stdout into
another tool, because npm writes its banner there too).

Containers are resolved by the compose project and service labels, never
by hard-coded names, so any suffix scheme works. Set
`DEPLOY_COMPOSE_PROJECT` when the deployment runs under another project
name, and `DEPLOY_DB_CONTAINER` when the database is not the `db` service
of the compose project. A separate PostgreSQL resource also carries its
own credentials, so set `DEPLOY_DB_USER` and `DEPLOY_DB_NAME` to match it.
All of these keys can live in `deploy/access.env` alongside the access
keys.

## Deploy with docker compose

1. Install Docker Engine with the compose plugin, clone this repository, and
   create a database password with `openssl rand -hex 24`. The compose file
   splices `POSTGRES_PASSWORD` into `DATABASE_URL` verbatim, so the password
   must hold only URI-safe characters; see the `DATABASE_URL` row below.
2. Copy `deploy/env.example` to `deploy/.env`. Fill in
   `POSTGRES_PASSWORD`, `RECOVERY_GENERATION`, `CREDENTIALS_KEY`, and
   `BASE_URL`. For a local trial without TLS, set
   `BASE_URL=http://localhost:8080` and `PREFLIGHT_ALLOW_HTTP=1`.
3. Start the stack: `docker compose -f deploy/docker-compose.yml up -d --build`.
   When a build fails to resolve names, add the build-networking override
   from [Build networking](#build-networking) to the same command.
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

## Build networking

A build fails on some hosts while `RUN` steps resolve names: the container
asks the resolver it was given and every query times out. The diagnosis
below is from the developer workstation, 2026-09-21, Docker 29.1.3.

### Root cause on the developer workstation

Docker writes each container's resolver from the host's
`/run/systemd/resolve/resolv.conf`, skipping the `127.0.0.53` stub. That
file names exactly one uplink, `10.77.0.1`, and the host reaches it only
through the Tailscale interface with policy routing
(`ip route get 10.77.0.1` shows `dev tailscale0 table 52`). Container
traffic leaves through the default bridge and never matches that route,
so the resolver is unreachable from inside any bridge container:

```sh
docker run --rm alpine:3.20 getent hosts registry.npmjs.org   # exit 2
docker run --rm --dns 10.77.0.1 alpine:3.20 nslookup registry.npmjs.org  # timeout
docker run --rm --dns 8.8.8.8 alpine:3.20 getent hosts registry.npmjs.org  # resolves
```

Host networking works because the container shares the host namespace and
the policy routing. Plain internet resolvers work from the bridge. A
`docker build` with the default network fails at the first `RUN` that
resolves a name; a BuildKit daemon configured with `[dns] nameservers`
does not help, because the builder container itself cannot resolve the
base image.

### Verified workarounds

- Plain builds: `docker build --network=host --target app -t mail-hub-app .`
- Compose builds: merge the opt-in override
  `deploy/docker-compose.host-build.yml`, which sets `build.network: host`
  for the `api`, `worker`, and `web` services:

  ```sh
  docker compose -f deploy/docker-compose.yml \
    -f deploy/docker-compose.host-build.yml build
  ```

Limits: the flag changes only `RUN` steps during the build. Those steps
then see the host's network, so a Dockerfile step that binds a port would
collide with host services. Neither this repository's Dockerfile nor its
dependencies bind ports while building. The override stays out of the
default files: hosts with working container DNS keep hermetic bridge
builds.

The host-side fix is to give systemd-resolved an uplink that bridge
traffic can reach — then the generated container resolver works and no
override is needed. That changes host configuration for every container
on the machine, so it is the host administrator's call.

The Coolify builder is a separate Docker host; run the three probe
commands above there before its first build. Its result was not
verifiable from the workstation on 2026-09-21 because the deploy host
was unreachable.

## Gate main before deployment

Every change reaches production through one path: a pull request into
`main` that passes the `release-gate` check, then a merge, which fires the
deployment webhook. Branch protection enforces the path.

1. Push a branch and open a pull request into `main`.
2. The `release-gate` workflow (`.github/workflows/release-gate.yml`) runs
   the strict release gate on a scratch PostgreSQL service and on Chromium.
   The check runs against the merge result. When `main` moves, protection
   blocks the merge until you update the branch. That update reruns the
   check, so an outdated green check cannot authorize a different tree.
3. Merge only a green and current pull request. The merge push triggers
   the deployment webhook; nothing else deploys.
4. Check the webhook delivery for the merge push with `npm run
   webhook:audit` (see [The webhook deployment
   path](#the-webhook-deployment-path); the delivery log also sits under
   the repository's **Settings → Webhooks**), then verify the deployment
   and its revision with `npm run deploy:verify` (it reads containers,
   the health endpoint, and the database — not the delivery).

Branch protection on `main` requires a pull request, requires the
`release-gate` check, requires branches to be up to date before merging,
and blocks force pushes and deletion. The rule includes administrators,
so the owner merges through pull requests like anyone else. Inspect it
under the repository's **Settings → Branches**.

Emergency bypass: an owner disables the branch protection in the
repository settings, merges or pushes directly, and re-enables it
immediately. Record every bypass with its reason.

The workflow holds no secrets. Pull requests never see deployment
credentials. The webhook secret stays in the GitHub webhook and Coolify
resource settings, and deployment runs only on `main` pushes.

Measured durations, 2026-09-21: the full local gate runs 258 seconds and
the runner gate runs 301 seconds, 355 with setup (pull request #1); one
focused admin suite runs 6 seconds; one focused gate suite runs 6 seconds.

## The webhook deployment path

The merge of a green pull request fires the only deployment trigger: a
signed `push` webhook from GitHub to the Coolify resource. Audit the whole
path with one read-only command:

```sh
npm run webhook:audit
```

The command checks the GitHub side live and reports one line per fact:
the hook (one active hook, `push` event, https destination, TLS
verification on), recent deliveries (acceptance and the ref of the latest
push), and the destination host. It masks the hook URL path — the path is
a capability — and never prints the secret or any token value. Add
`-- --json` for machine-readable output.

Two facts the audit states instead of guessing:

- A 2xx delivery response records that the destination accepted the
  request. It does not record a deployment. Only the Coolify side — its
  API or `npm run deploy:verify` against the running stack — closes that
  gap, so the audit prints a `coolify` line: `ok` when configured, or
  `not_configured` naming `DEPLOY_COOLIFY_URL` and `COOLIFY_TOKEN` from
  `deploy/access.env`.
- GitHub never returns the webhook secret. The `secret` line reports
  `unknown` and names the two ways to prove it: a signed redelivery during
  an authorized window, or inspection of the Coolify resource.

### Test modes

Both modes are opt-in on the command line. The audit is read-only without
them.

- `npm run webhook:audit -- --send-test` asks GitHub to send a ping. A
  ping proves the destination answers with the shared secret. It never
  starts a deployment.
- `npm run webhook:audit -- --redeliver <delivery-id>` asks GitHub to
  replay one recorded delivery. When its ref is `main`, the replay starts
  a real deployment. The command refuses without `--allow-deployment`;
  identify the commit first (the delivery log under the repository's
  **Settings → Webhooks** shows the ref and the request payload) and
  confirm the deployment window before you allow it.

### Secret ownership and rotation

The secret exists in exactly two places: the repository webhook settings
on GitHub and the Coolify resource configuration. It never lives in this
repository, in `deploy/.env`, or in `deploy/access.env`. Rotate it only
for a reason, for example a suspected exposure:

1. Generate a new secret: `openssl rand -hex 24`.
2. Set it in the Coolify resource configuration first, then in the
   repository webhook settings on GitHub.
3. Prove the pair with `--send-test`, then watch the next delivery.
4. The old secret stops working the moment GitHub saves the new one; no
   revocation step exists on the Coolify side beyond the saved value.

### Where the records live

- GitHub: the repository's **Settings → Webhooks** page. Each delivery
  shows its event, status code, response, and payload, and offers a
  redelivery button. The audit's delivery facts come from this API.
- Coolify: the resource's deployment list, which names the commit each
  deployment built and its outcome. Correlate it with `npm run
  deploy:verify`, which reads the running stack itself.

### Isolated coverage

`apps/admin/test/webhook-audit.test.ts` pins the audit's contracts
without touching the network: signature verification over raw request
bytes (including the re-serialized-JSON failure), branch selection,
duplicate delivery handling, the redelivery guard, and the
classifiers that keep acceptance and deployment distinct. The receiver
harness runs on an ephemeral loopback port inside the test process.

### Current state, 2026-09-21

The GitHub side is verified live: one active `push` hook with a https
destination, every recent delivery accepted, the latest push delivery
carrying its ref and commit. The Coolify side is not configured on this
workstation (`deploy/access.env` is absent and the deploy host is
unreachable), so acceptance-to-deployment correlation is unproven. The
audit reports this state itself: its `coolify` line reads
`not_configured` and its verdict says acceptance is proven, not
deployment.

## Environment reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string. The entrypoint applies migrations against it before the server starts. The compose file builds it as `postgres://mail_hub:${POSTGRES_PASSWORD}@db:5432/mail_hub`, splicing the password in verbatim, so a compose-set password must hold only URI-safe characters: `openssl rand -hex 24` is safe, while `base64` output can contain `/`. Characters with URI meaning (`@`, `:`, `/`, `%`, `#`, `?`, space) break the connection string; percent-encode them only when you set `DATABASE_URL` yourself, because the server keeps the raw password. |
| `RECOVERY_GENERATION` | yes | A UUID from deployment configuration. Generate with `uuidgen` at installation, keep it across restarts and releases, and set a new value for every restore. Never recover it from the database or a backup. |
| `CREDENTIALS_KEY` | yes | 32 bytes as base64 or hex. Generate with `openssl rand -base64 32`. Seals stored mailbox passwords. Back it up separately from the database. |
| `BASE_URL` | yes | The deployed HTTPS origin, for example `https://mail.example.com`. Passkey ceremonies and origin checks use it. |
| `HOST` / `PORT` | no | Listener binding. The image defaults to `0.0.0.0:3000`. |
| `STORAGE_ROOT` | no | Object storage root. The image default is `/app/data/storage`. |
| `APP_ROLE` | no | `all` (default), `api`, or `worker`. Only the `api` and `all` roles run migrations. |
| `TYPE_SAFE_API_KEY` | no | Jev classification key. Core mail never waits on it. |
| `SYNC_CYCLE_CRON`, `SEND_CYCLE_CRON`, `SENT_COPY_CYCLE_CRON`, `CLASSIFY_CYCLE_CRON` | no | Worker schedule overrides. Set them only to a valid cron expression; an empty or missing value keeps the image default. |
| `BACKUP_DIR`, `BACKUP_KEEP` | no | Backup destination (default `/backups`) and retention count (default 14). `BACKUP_KEEP` must be a positive integer; the backup refuses to start on any other value. |
| `BACKUP_GC_STALE_SECONDS` | no | Age at which a leftover collection-pause marker is taken over (default 43200). |
| `PREFLIGHT_ALLOW_HTTP` | no | Set to `1` only for local trials, to accept an `http` `BASE_URL`. |

`deploy/preflight.mjs` checks all of this before the container starts and
fails fast with one message per problem. The checks mirror the parsers the
services use, so a passing preflight means the API opens its routes.

A command passed to the app container replaces the startup sequence: the
entrypoint runs it and skips preflight, migrations, and the server. The
backup schedule and the restore runbook rely on this (`docker compose
-f deploy/docker-compose.yml run --rm api npm run backup`).

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

### Adapter smoke check

After a deployment, and whenever the adapter, the question set, the pinned
model, or the endpoint changes, run one synthetic call against the
configured service:

```sh
npm run verify:classify
```

The command sends invented text — no mail, no database writes — and prints
approved fields only: model, question set version, answers, latency, and
token count. It never prints the API key. A missing `TYPE_SAFE_API_KEY`
prints an explicit unverified result; the exit code is 0 only when the
service answers the documented contract. Offline contract fixtures in
`packages/classification/test/fixtures/typesafe-contract.ts` pin the same
wire shape, so drift fails the test suite before it reaches a deployment.

## Backups

`deploy/backup.sh` runs inside the app container (`npm run backup`):

1. The script claims the collection pause (below), then `pg_dump` writes a
   consistent snapshot in custom format. The snapshot is online-safe while
   the app runs.
2. The durable object tree is copied after the snapshot while collection
   stays paused, so the copy covers everything the snapshot references.
   Objects written later are harmless orphans.
3. `deploy/verify-backup.mjs` writes `manifest.sha256` with the hash of every
   file, then re-hashes every file and cross-checks every storage sidecar
   against the copied bytes.
4. Backups older than `BACKUP_KEEP` timestamp directories are removed.

A bundle never contains `CREDENTIALS_KEY`. Store the key in a password
manager or a second secret store. The database snapshot does carry the
recovery generation last recorded in `service_state`; that recorded value
must never be reused, and a restore always sets a new generation from
deployment configuration.

### Collection pause

SPEC section 10 step 6 requires copying durable objects while garbage
collection is paused. No sweep is implemented yet; the coordination it must
honor when it lands is a marker directory at `$STORAGE_ROOT/gc-pause`.
`deploy/backup.sh` creates the marker before the snapshot and removes it
when the backup ends. A future sweep treats the marker the same way: while
it exists, no durable object is deleted; the sweep resumes, and observes its
grace period, once the marker is gone. `mkdir` makes the claim atomic, so
two backup runs cannot hold the pause at once. A marker left by a killed
run stops later backups with an error until it is older than
`BACKUP_GC_STALE_SECONDS` (default 43200, twelve hours), after which the
next backup takes it over. Remove the marker by hand only after confirming
no backup is running.

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

The database restore is atomic and total: it drops the `public`, `drizzle`,
and `pgboss` schemas and replays the snapshot inside one transaction. The
schema drop also removes objects that a migration added after the backup was
taken, which per-object `--clean` statements cannot know about; without it,
restoring an older bundle onto a newer schema rewinds the migration journal
and the entrypoint crash-loops re-applying migrations that collide with the
leftovers. The queue schema must drop too, because the snapshot is
whole-database: a `pgboss` schema left in the target collides with the
replayed `CREATE SCHEMA` and the restore aborts. The replay rebuilds the
queue with the jobs the backup holds, recovery holds them disabled through
the job gate, and pg-boss re-applies its own migrations on the next start.
Any error rolls the whole restore back, leaving the database exactly as it
was.

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
3. Cut a release only through a green `release-gate` check on the merged
   pull request (see [Gate main before deployment](#gate-main-before-deployment)).
   Run `npm run release:gate -- --strict` locally first; it is the same
   command the runner executes.

## Resource sizing

- 2 GB RAM instance. One IMAP connection per account during backfill.
- Watch free disk space. Pause imports and uploads before durable writes
  become unsafe.
- The app image carries development dependencies (`tsx`, `drizzle-kit`)
  because it runs TypeScript from source; size the disk accordingly.

## Verification checklist

- `npm run deploy:access` passes from the operator workstation (see
  [Operator access](#operator-access)).
- `npm run webhook:audit` reports the hook, deliveries, and destination
  healthy, and its `coolify` line reads `ok` once the Coolify keys are
  configured (see [The webhook deployment
  path](#the-webhook-deployment-path)).
- `npm run deploy:verify` reports `VERIFIED` (see
  [Verify a deployment](#verify-a-deployment)); with accounts enrolled,
  run it with `--sample-interval` so stalled sync cannot hide behind
  healthy containers.
- With `TYPE_SAFE_API_KEY` configured, `npm run verify:classify` reports
  `VERIFIED` against the configured service (see
  [Adapter smoke check](#adapter-smoke-check)).
- `docker compose -f deploy/docker-compose.yml ps` reports `db`, `api`,
  `worker`, and `web` healthy or running.
- `curl https://mail.example.com/api/healthz` answers `200` with the recovery
  state, sync lag, and queue age.
- `ls /backups/<latest>` shows `database.pgdump`, `database.catalog`,
  `storage-durable/`, `manifest.sha256`, and `BACKUP-INFO.txt`.
- `docker compose ... run --rm api node deploy/verify-backup.mjs --check
  /backups/<latest>` reports every file hashed and every sidecar cross-checked.
