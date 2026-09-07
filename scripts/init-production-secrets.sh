#!/usr/bin/env bash
# Creates ./secrets/ with one file per compose secret. Generates the random ones; leaves the
# operator-supplied ones as TODO placeholders. Never overwrites a file that already exists.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p secrets && chmod 700 secrets
gen() { [ -s "secrets/$1" ] || { printf '%s' "$2" > "secrets/$1"; chmod 600 "secrets/$1"; echo "  generated $1"; }; }
todo() { [ -s "secrets/$1" ] || { printf 'TODO %s' "$2" > "secrets/$1"; chmod 600 "secrets/$1"; echo "  PLACEHOLDER $1 - $2"; }; }

echo "Generated automatically:"
for n in auth_secret booking_capability_secret tenant_context_secret rate_limit_hash_secret \
         proxy_shared_secret operator_health_secret email_token_secret client_gate_secret; do
  gen "$n" "$(openssl rand -hex 32)"
done
gen token_encryption_key "$(openssl rand -hex 32)"          # exactly 64 hex characters
gen booking_capability_keyring '{}'                          # JSON object; add retired keys on rotation
gen postgres_owner_password "$(openssl rand -hex 24)"

echo "You must fill these in:"
todo app_database_url        "postgresql://tempocove_app_login:PW@postgres:5432/tempocove?sslmode=verify-full&sslrootcert=/run/secrets/postgres_ca_cert&connect_timeout=3&pool_timeout=20&connection_limit=20&statement_timeout=2000"
todo worker_database_url     "same as app_database_url but tempocove_worker_login"
todo monitor_database_url    "same shape but tempocove_monitor_login"
todo migration_database_url  "tempocove_owner; psql only - NO pool_timeout or connection_limit"
todo google_client_secret    "from Google Cloud Console"
todo smtp_password           "from your SMTP provider"
todo client_gate_password_hash "scrypt:v1:... - generate with the studio password, never plaintext"
todo postgres_server_cert    "PEM server certificate"
todo postgres_server_key     "PEM private key"
todo postgres_ca_cert        "PEM CA certificate that signed the server cert"

echo
echo "Directory is mode 700 and gitignored. Review every TODO before deploying:"
grep -l '^TODO' secrets/* 2>/dev/null | sed 's/^/  /' || echo "  none outstanding"
