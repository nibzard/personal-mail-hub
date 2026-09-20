#!/bin/sh
# Nightly off-box backup (SPEC.md section 10, step 6). Run it inside the app
# container, with BACKUP_DIR on a volume that leaves the host:
#
#   sh /app/deploy/backup.sh          (or: npm run backup)
#
# What it does, in order:
#
#   1. Pause durable-object garbage collection (see "Collection pause"
#      below), then take a consistent database snapshot with pg_dump.
#      Custom format, one MVCC snapshot, online-safe while the app runs.
#   2. A copy of the durable object tree (originals, uploads, outbound MIME
#      bytes and their .meta.json sidecars), taken while collection stays
#      paused. The snapshot runs first, so the object copy is a superset of
#      everything the snapshot references, and objects written afterwards
#      are harmless orphans. The disposable cache is deliberately excluded;
#      it regenerates.
#   3. A manifest with the sha256 of every file, plus an integrity pass that
#      re-hashes every file and cross-checks every sidecar against the copied
#      bytes (deploy/verify-backup.mjs).
#   4. Retention: keep the newest BACKUP_KEEP timestamp directories.
#
# The bundle contains no CREDENTIALS_KEY: back the key up separately. The
# database snapshot does carry the recovery generation last recorded in
# service_state. That recorded value is history; it must never be reused.
# A restore always sets a new generation from deployment configuration.
#
# Collection pause (SPEC.md section 10, step 6): the copy must not lose an
# object the snapshot references. Nothing implements the sweep yet; when it
# lands, it must honor the marker directory $STORAGE_ROOT/gc-pause. While
# the marker exists, the sweep deletes no durable object; it resumes (and
# observes its grace period) once the marker is gone. This script claims the
# marker before the snapshot and releases it when the whole backup ends, so
# the pause also covers verification and retention. A marker left behind by
# a killed run is taken over once it is older than BACKUP_GC_STALE_SECONDS.
# A run that fails anywhere removes its own incomplete bundle directory, so
# retention and a later restore never see a half-written backup.
set -eu

app_root="${APP_ROOT:-/app}"
storage_root="${STORAGE_ROOT:-$app_root/data/storage}"
backups="${BACKUP_DIR:-/backups}"
retain="${BACKUP_KEEP:-14}"
stale_seconds="${BACKUP_GC_STALE_SECONDS:-43200}"

: "${DATABASE_URL:?DATABASE_URL must be set for the database snapshot.}"

for tool in pg_dump pg_restore node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "backup: $tool is required but was not found in PATH." >&2
    exit 1
  fi
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$backups/$timestamp"
mkdir -p "$dest"
backup_complete=0

# Collection pause: claim the marker before anything reads the durable tree.
# mkdir is atomic, so two backup runs cannot both hold it. The marker sits
# beside durable/, not inside it, so it never becomes bundle content.
pause_dir="$storage_root/gc-pause"
mkdir -p "$storage_root"
if ! mkdir "$pause_dir" 2>/dev/null; then
  if [ -n "$(find "$pause_dir" -maxdepth 0 -mmin +"$((stale_seconds / 60))" -print 2>/dev/null)" ]; then
    echo "backup: taking over the collection pause at $pause_dir; the marker is older than ${stale_seconds}s." >&2
    rm -rf -- "$pause_dir"
    mkdir "$pause_dir"
  else
    echo "backup: $pause_dir exists, so another backup holds the collection pause." >&2
    echo "backup: remove it by hand only after confirming no backup is running." >&2
    exit 1
  fi
fi
printf 'pid=%s started=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$pause_dir/owner"

finish() {
  # A failed run must not leave a half-written bundle behind: retention would
  # count it, and an operator in a restore must not mistake it for a backup.
  if [ "$backup_complete" -ne 1 ]; then
    rm -rf -- "${backups:?}/${timestamp:?}"
    echo "backup: removed the incomplete bundle $timestamp." >&2
  fi
  rm -rf -- "$pause_dir"
}
trap finish EXIT
trap 'exit' INT TERM

# 1. Consistent database snapshot.
pg_dump --format=custom --file "$dest/database.pgdump" "$DATABASE_URL"
# A readable table of contents proves the dump parses and records what it holds.
pg_restore --list "$dest/database.pgdump" >"$dest/database.catalog"

# 2. Durable objects; the collection pause above covers this copy.
mkdir -p "$dest/storage-durable"
if [ -d "$storage_root/durable" ]; then
  cp -a "$storage_root/durable/." "$dest/storage-durable/"
else
  echo "backup: no durable object tree at $storage_root/durable (fresh installation)." >&2
fi

# 3. Manifest and verification.
{
  echo "mail hub backup $timestamp"
  echo "created: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tooling: $(pg_dump --version)"
  echo
  echo "contents:"
  echo "  database.pgdump     consistent snapshot, pg_dump custom format"
  echo "  database.catalog    table of contents of the snapshot"
  echo "  storage-durable/    durable objects with .meta.json sidecars"
  echo "  manifest.sha256     sha256 of every file in this directory"
  echo
  echo "This bundle does NOT contain CREDENTIALS_KEY. The key is backed up"
  echo "separately from the database."
  echo
  echo "The database snapshot DOES contain the recovery generation last"
  echo "recorded in service_state. That recorded value must never be reused:"
  echo "a restore always sets a NEW recovery generation in deployment"
  echo "configuration, generated outside the database and this bundle."
} >"$dest/BACKUP-INFO.txt"

node "$app_root/deploy/verify-backup.mjs" --write "$dest"
node "$app_root/deploy/verify-backup.mjs" --check "$dest"

# 4. Retention.
kept=0
for old in $(ls -1 "$backups" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r); do
  kept=$((kept + 1))
  if [ "$kept" -gt "$retain" ]; then
    rm -rf -- "${backups:?}/$old"
    echo "backup: removed $old beyond the retention of $retain."
  fi
done

backup_complete=1
echo "backup: complete at $dest"
