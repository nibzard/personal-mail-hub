#!/bin/sh
# Nightly off-box backup (SPEC.md section 10, step 6). Run it inside the app
# container, with BACKUP_DIR on a volume that leaves the host:
#
#   sh /app/deploy/backup.sh          (or: npm run backup)
#
# What it does, in order:
#
#   1. A consistent database snapshot with pg_dump. Custom format, one MVCC
#      snapshot, online-safe while the app runs.
#   2. A copy of the durable object tree (originals, uploads, outbound MIME
#      bytes and their .meta.json sidecars). The snapshot runs first, so the
#      object copy is a superset of everything the snapshot references:
#      referenced durable objects are never deleted underneath a backup, and
#      objects written afterwards are harmless orphans. The disposable cache
#      is deliberately excluded; it regenerates.
#   3. A manifest with the sha256 of every file, plus an integrity pass that
#      re-hashes every file and cross-checks every sidecar against the copied
#      bytes (deploy/verify-backup.mjs).
#   4. Retention: keep the newest BACKUP_KEEP timestamp directories.
#
# The bundle never contains CREDENTIALS_KEY or RECOVERY_GENERATION. Back the
# key up separately, and always set a new generation for a restore.
set -eu

app_root="${APP_ROOT:-/app}"
storage_root="${STORAGE_ROOT:-$app_root/data/storage}"
backups="${BACKUP_DIR:-/backups}"
retain="${BACKUP_KEEP:-14}"

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

# 1. Consistent database snapshot.
pg_dump --format=custom --file "$dest/database.pgdump" "$DATABASE_URL"
# A readable table of contents proves the dump parses and records what it holds.
pg_restore --list "$dest/database.pgdump" >"$dest/database.catalog"

# 2. Durable objects.
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
  echo "This bundle does NOT contain CREDENTIALS_KEY or RECOVERY_GENERATION."
  echo "The key is backed up separately from the database; a restore always"
  echo "sets a new recovery generation in deployment configuration."
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

echo "backup: complete at $dest"
