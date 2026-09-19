#!/bin/sh
# Container entrypoint (SPEC.md section 10, step 3): check the environment,
# apply migrations, then start the API and the worker.
#
# APP_ROLE selects the process layout:
#   all    (default) one container runs the worker beside the API
#   api    only the Fastify process; migrations run first
#   worker only the worker; migrations are left to the api role
#
# Arguments replace the whole sequence: the backup schedule and the restore
# runbook start one-off containers with a command, and a restore must not
# race preflight, migrations, and the API against the live database.
set -eu

app_root="${APP_ROOT:-/app}"
cd "$app_root"

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

# The gateway and the platform proxy reach the API over the container
# network, so it must listen on all interfaces.
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-3000}"

role="${APP_ROLE:-all}"
case "$role" in
  all | api | worker) ;;
  *)
    echo "APP_ROLE must be all, api, or worker (got: $role)." >&2
    exit 64
    ;;
esac

node deploy/preflight.mjs

if [ "$role" != "worker" ]; then
  # Apply migrations through the deployment path before the server starts.
  # The worker role skips this so two containers never migrate at once.
  npm run db:migrate --workspace=@mail-hub/database
fi

# The servers run through tsx directly, without the npm intermediary: npm
# does not forward signals to its child, and both processes close gracefully
# on SIGTERM only when the signal reaches them.
api_command="node node_modules/.bin/tsx apps/api/src/main.ts"
worker_command="node node_modules/.bin/tsx apps/worker/src/main.ts"

if [ "$role" = "api" ]; then
  exec $api_command
fi
if [ "$role" = "worker" ]; then
  exec $worker_command
fi

# One container, both processes: the API runs in the foreground while the
# worker runs beside it. When either process exits, stop the other and pass
# the exit status through so the platform restarts the container.
$worker_command &
worker_pid=$!
$api_command &
api_pid=$!

stop_both() {
  trap - TERM INT
  kill -TERM "$api_pid" "$worker_pid" 2>/dev/null || true
}
trap stop_both TERM INT

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$worker_pid" 2>/dev/null; do
  sleep 1
done

# Whichever process exited sets the exit status; the other is stopped and
# waited for, so no process is left running and the platform restarts the
# container on the status of the process that actually failed.
status=0
if kill -0 "$api_pid" 2>/dev/null; then
  # The worker exited first.
  wait "$worker_pid" || status=$?
  kill -TERM "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
else
  # The API exited first.
  wait "$api_pid" || status=$?
  kill -TERM "$worker_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
fi
exit "$status"
