#!/bin/bash
# Creates multiple databases listed in POSTGRES_MULTIPLE_DATABASES (comma-separated).
# Runs once on first container init (empty data dir). Idempotent guards included.
set -euo pipefail

create_database() {
  local db="$1"
  echo "  init-db: ensuring database '$db'"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE "$db"'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$db')\gexec
EOSQL
}

if [ -n "${POSTGRES_MULTIPLE_DATABASES:-}" ]; then
  echo "init-db: requested databases = $POSTGRES_MULTIPLE_DATABASES"
  IFS=',' read -ra DBS <<< "$POSTGRES_MULTIPLE_DATABASES"
  for db in "${DBS[@]}"; do
    create_database "$(echo "$db" | xargs)"  # trim whitespace
  done
  echo "init-db: all databases ensured"
fi
