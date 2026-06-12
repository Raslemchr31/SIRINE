#!/bin/bash
# On the catalog (directus) DB: enable extensions used for retrieval, and create a
# read-only role that retrieval-api will use (M4) so the live path can only READ.
# pg_trgm powers the explicit-mention (fuzzy name) resolution step. NO pgvector in v1.
set -euo pipefail

CATALOG_DB="directus"
RO_ROLE="${CATALOG_RO_ROLE:-catalog_ro}"
RO_PASSWORD="${CATALOG_RO_PASSWORD:-catalog_ro_changeme}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$CATALOG_DB" <<-EOSQL
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  DO \$\$
  BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RO_ROLE}') THEN
      CREATE ROLE ${RO_ROLE} LOGIN PASSWORD '${RO_PASSWORD}';
    END IF;
  END
  \$\$;

  GRANT CONNECT ON DATABASE ${CATALOG_DB} TO ${RO_ROLE};
  GRANT USAGE ON SCHEMA public TO ${RO_ROLE};
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RO_ROLE};

  -- Future tables Directus creates (as ${POSTGRES_USER}) become SELECTable by the RO role.
  ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
    GRANT SELECT ON TABLES TO ${RO_ROLE};
EOSQL

echo "init-db: catalog extensions + read-only role '${RO_ROLE}' ready"
