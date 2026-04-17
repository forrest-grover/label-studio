#!/usr/bin/env bash
# Resets JWT token settings on the default (id=1) test organization to the
# production-safe default: JWT API tokens on, legacy API tokens off.
#
# Why this exists:
# During the tus-upload curl smoke test we temporarily flipped
# legacy_api_tokens_enabled=true on the dev organization so DRF Token auth
# would work for scripted PATCH requests. That must never leak into any
# shared/shipped state. Run this script after any such experiment.
#
# Usage (from repo root, with docker compose stack up):
#   bash deploy/reset_default_org_token_settings.sh
#
# Idempotent; safe to re-run.
set -euo pipefail

docker compose exec -T db psql -U postgres -d postgres <<'SQL'
UPDATE jwt_auth_jwtsettings
   SET api_tokens_enabled = true,
       legacy_api_tokens_enabled = false
 WHERE organization_id = 1;
SELECT organization_id, api_tokens_enabled, legacy_api_tokens_enabled
  FROM jwt_auth_jwtsettings
 ORDER BY organization_id;
SQL
