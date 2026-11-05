# soma — secrets manifest (committed; values live in 1Password).
# Local dev / admin scripts: op run --env-file=.env.tpl -- <cmd>
#
# Cloudflare credentials are minted by scripts/provision.py. Apple push keys
# are provisioned for this service through the Apple Developer portal.
#
# Refs are BY NAME: op-project-bootstrap parses this file to create the vault
# and items, so IDs cannot exist yet. See the global AGENTS.md exception.
#
# Service runtime secrets persist in the Worker's supported secret storage.
# HUB_TOKEN is operator-only; clients enroll independent revocable credentials.
# Governance's stable deployment identity and dedicated preview key belong to
# server configuration, never client settings. See docs/governance-service.md.

CLOUDFLARE_API_TOKEN=op://Soma/Soma CI Cloudflare Token/api-token
CLOUDFLARE_ACCOUNT_ID=op://Soma/Soma CI Cloudflare Token/account-id

APNS_CONFIG=op://Soma/Soma ENV/APNS_CONFIG
APNS_PRIVATE_KEY=op://Soma/Soma ENV/APNS_PRIVATE_KEY

# Exact browser origins allowed to read API responses, comma-separated.
CORS_ORIGINS=op://Soma/Soma ENV/CORS_ORIGINS

# Consumer-access policy (docs/consumer-access.md): JSON objects, {} when unused.
# Deploy pushes them, so these fields are the declarative source of truth.
ENROLLMENT_PROFILES=op://Soma/Soma ENV/ENROLLMENT_PROFILES
ROW_CREATION_POLICIES=op://Soma/Soma ENV/ROW_CREATION_POLICIES
# Capture gateway adapters (docs/scoped-enrollment.md), {} when unused.
CAPTURE_ADAPTERS=op://Soma/Soma ENV/CAPTURE_ADAPTERS

# The backup cron's Cloudflare token for D1's export API (D1 Write, minted by
# scripts/provision.py; see worker/src/backup.js).
BACKUP_API_TOKEN=op://Soma/Soma ENV/BACKUP_API_TOKEN
