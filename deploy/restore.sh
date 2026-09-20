#!/bin/sh
# Restore procedure (SPEC.md section 10). This script performs the mechanical
# half of steps 1 and 2: it verifies the backup's hashes, restores the
# database snapshot, and puts the durable objects back. The recovery steps
# that follow are operator commands, printed at the end and documented in
# deploy/README.md; they are what make the restored deployment safe.
#
# The database restore is atomic and total. It drops the application schemas
# (public and drizzle) and the queue schema (pgboss) instead of relying on
# per-object DROP statements: a schema drop also removes objects a later
# migration added after the backup was taken, which --clean cannot know
# about. Without that, restoring an older bundle onto a newer schema rewinds
# the migration journal, the entrypoint re-applies migrations, and the first
# one collides with the leftover objects in a crash loop. The queue schema
# must go too: the dump carries it (the snapshot is whole-database), so a
# surviving pgboss schema collides with the replayed CREATE SCHEMA and
# ON_ERROR_STOP aborts the restore. The replay rebuilds the queue with the
# jobs the backup holds; recovery keeps them disabled through the job gate,
# and pg-boss re-applies its own migrations on the next start. The reset and
# the whole snapshot then apply inside ONE transaction with ON_ERROR_STOP,
# so any failure rolls back and leaves the previous database exactly as it
# was.
#
#   sh /app/deploy/restore.sh /backups/20260919T030000Z --yes
#
# Stop the API and the worker before restoring, and restore into the same
# database the deployment uses. The script refuses to run without --yes.
set -eu

app_root="${APP_ROOT:-/app}"
storage_root="${STORAGE_ROOT:-$app_root/data/storage}"

usage() {
  echo "Usage: sh $0 <backup-dir> --yes" >&2
  echo "       sh $0 <backup-dir>   (prints the plan only)" >&2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 64
fi

source_dir="$1"
confirmed="${2:-}"

for required in database.pgdump database.catalog storage-durable manifest.sha256; do
  if [ ! -e "$source_dir/$required" ]; then
    echo "restore: $source_dir/$required is missing; this is not a backup directory." >&2
    exit 1
  fi
done

: "${DATABASE_URL:?DATABASE_URL must name the database to restore into.}"

for tool in pg_restore psql node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "restore: $tool is required but was not found in PATH." >&2
    exit 1
  fi
done

echo "restore: verifying hashes in $source_dir before touching anything."
node "$app_root/deploy/verify-backup.mjs" --check "$source_dir"

if [ "$confirmed" != "--yes" ]; then
  cat <<EOF

Plan (not executed; repeat with --yes to apply):
  1. Stop the API and the worker. They must not run against a half-restored
     database, and an old process must not continue a remote operation.
  2. Restore the snapshot into:
     $DATABASE_URL
     One transaction: drop the public, drizzle, and pgboss schemas (which
     also removes objects later migrations added), then replay the snapshot.
     Any error rolls the database back to its pre-restore state.
  3. Copy $source_dir/storage-durable back under $storage_root/durable.
  4. Delete $storage_root/cache: the disposable cache regenerates from the
     restored originals.
  5. Set a NEW RECOVERY_GENERATION in deployment configuration, then follow
     the recovery runbook this script prints after a restore.
EOF
  exit 2
fi

# Stage the SQL first: a corrupt archive must abort before any of it runs.
# The plain text can be several times the size of the custom-format dump.
restore_sql="$(mktemp "${TMPDIR:-/tmp}/mail-hub-restore.XXXXXX.sql")"
remove_staged_sql() {
  rm -f -- "$restore_sql"
}
trap remove_staged_sql EXIT
trap 'exit' INT TERM

{
  echo "DROP SCHEMA IF EXISTS public CASCADE;"
  echo "DROP SCHEMA IF EXISTS drizzle CASCADE;"
  # The queue schema rides in the dump; a leftover copy collides with the
  # replayed CREATE SCHEMA. A dump from before any worker ran holds no queue
  # schema, so IF EXISTS also covers that bundle.
  echo "DROP SCHEMA IF EXISTS pgboss CASCADE;"
  echo "CREATE SCHEMA public;"
  # --file - writes the plain SQL stream to stdout; --dbname is not used,
  # so nothing touches the database while the stream is produced.
  pg_restore --file - --no-owner --no-privileges "$source_dir/database.pgdump"
} >"$restore_sql"

echo "restore: applying the database snapshot in one transaction."
psql \
  --set=ON_ERROR_STOP=1 \
  --single-transaction \
  --dbname "$DATABASE_URL" \
  --file "$restore_sql"
remove_staged_sql

echo "restore: copying durable objects back."
mkdir -p "$storage_root/durable"
cp -a "$source_dir/storage-durable/." "$storage_root/durable/"

echo "restore: clearing the disposable cache."
rm -rf -- "${storage_root:?}/cache"
mkdir -p "$storage_root/cache"

cat <<'EOF'

Database and durable objects are restored. The deployment is NOT usable yet:
workers and mail mutations stay blocked until recovery completes. Continue
with the recovery runbook (SPEC.md section 10):

  1. Set a NEW RECOVERY_GENERATION in the deployment environment now, before
     starting the app. Never reuse the previous value and never take one from
     the database or the backup bundle.
  2. Start the API (and worker). They come up blocked, by design.
  3. npm run admin -- recovery begin
     Records the new generation, enters reconciling, and revokes restored
     sessions, grants, challenges, and credentials. Repeating the command
     resumes without repeating the revocation.
  4. npm run admin -- recovery hold-actions
     Dispositions the management actions the restore left behind: old queued
     items become conflicted, old executing items unknown.
  5. Reconcile restored pending sends against durable responses and server
     evidence. Keep unresolved sends at outcome unknown; never auto-resend.
  6. npm run admin -- auth recover
     Prints a one-time replacement enrollment token; register the new
     passkey with it and verify you can sign in and inspect held operations.
  7. npm run admin -- recovery complete
     Requires the owner, the matching deployment generation, and disposition
     of all restored pending operations, then reopens normal work.

Run every command inside the app container with DATABASE_URL,
RECOVERY_GENERATION, and BASE_URL set to the deployment's values.
EOF

echo "restore: complete."
