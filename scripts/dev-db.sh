#!/usr/bin/env bash
# Development PostgreSQL, without needing a compose provider installed.
#
#   scripts/dev-db.sh up       start (creates the volume on first run)
#   scripts/dev-db.sh down     stop and remove the container, keep the data
#   scripts/dev-db.sh reset    discard the data and start clean
#   scripts/dev-db.sh psql     open a shell on the database
#   scripts/dev-db.sh status
#
# For the compose equivalent see scripts/docker/compose.dev.yaml.
set -euo pipefail

ENGINE="${CONTAINER_ENGINE:-podman}"
NAME=garuda-dev-postgres
VOLUME=garuda-dev-pgdata
IMAGE=docker.io/library/postgres:18-alpine
# 5433 by default: a system PostgreSQL usually already holds 5432, and a dev
# database that fights the machine's own is a bad first-run experience.
PORT="${GARUDA_DB_PORT:-5433}"

start() {
    if "$ENGINE" container exists "$NAME" 2>/dev/null; then
        "$ENGINE" start "$NAME" >/dev/null
        echo "started existing $NAME"
    else
        "$ENGINE" run -d --name "$NAME" \
            -e POSTGRES_DB=garuda \
            -e POSTGRES_USER=garuda \
            -e POSTGRES_PASSWORD=garuda \
            -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C" \
            -p "${PORT}:5432" \
            -v "${VOLUME}:/var/lib/postgresql/data" \
            "$IMAGE" \
            postgres -c log_min_duration_statement=1000 -c timezone=UTC >/dev/null
        echo "created $NAME on port $PORT"
    fi
    printf 'waiting for postgres'
    for _ in $(seq 30); do
        if "$ENGINE" exec "$NAME" pg_isready -U garuda -d garuda >/dev/null 2>&1; then
            echo " — ready"
            return 0
        fi
        printf '.'
        sleep 1
    done
    echo " — timed out"
    return 1
}

case "${1:-up}" in
    up)     start ;;
    down)   "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true; echo "removed $NAME (volume $VOLUME kept)" ;;
    reset)  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
            "$ENGINE" volume rm "$VOLUME" >/dev/null 2>&1 || true
            echo "discarded $VOLUME"; start ;;
    psql)   "$ENGINE" exec -it "$NAME" psql -U garuda -d garuda ;;
    status) "$ENGINE" ps --filter "name=$NAME" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
    *)      echo "usage: $0 {up|down|reset|psql|status}" >&2; exit 2 ;;
esac
