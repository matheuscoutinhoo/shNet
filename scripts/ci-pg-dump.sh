#!/usr/bin/env bash
set -euo pipefail
exec docker exec -i --env PGHOST=127.0.0.1 --env PGPORT=5432 --env PGDATABASE --env PGUSER --env PGPASSWORD --env PGSSLMODE "$POSTGRES_SERVICE_CONTAINER" pg_dump "$@"
