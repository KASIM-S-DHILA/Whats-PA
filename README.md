# WhatsApp File Assistant

A Cloudflare Worker for private, per-number WhatsApp conversations, documents, PDF questions, reminders and voice tools. It uses D1 for metadata/jobs, Supabase for private objects, Vectorize and Workers AI for retrieval, LiveKit for hosted calls, and an authenticated Python service for PDF/native vector work.

This repository contains source and configuration examples. It contains no live credentials, user documents, raw messages, deployment allowlist or production database.

## Start here

1. Install Node.js 22 or newer and run `npm ci`.
2. Copy `wrangler.chat.example.jsonc` to `wrangler.chat.jsonc`, and `.dev.vars.example` to `.dev.vars`.
3. Fill your own Cloudflare resources, Meta IDs, storage/service URLs and local secret values. Actual configuration and secrets are ignored by Git.
4. Follow [setup](docs/SETUP.md) before applying migrations or deploying.

> Working-copy note: this folder is both the local installation and the Git checkout. Keep the ignored `.dev.vars`, `wrangler.chat.jsonc`, `agents/livekit/livekit.toml`, `.local/`, `evidence/`, and private `docs/` files in place; only copy the examples on a fresh checkout.

```powershell
Copy-Item wrangler.chat.example.jsonc wrangler.chat.jsonc
Copy-Item .dev.vars.example .dev.vars
npm ci
# After configuring your own resources:
npm run build
```

The example scheduler is disabled and additional-owner allowlist is empty. Enable background work deliberately after provisioning and reviewing pending jobs/reminders. A dry build compiles source; it does not establish live integration behavior.

## Source map

- `src/chat-recovery-v1/`: active webhook, conversation jobs, owner scheduler, reminders, call tools and upload alarms.
- `src/owners.js`: exact-number membership and immutable scoped environments.
- `src/rag-rebuild/`: owned library retrieval, paged PDFs, summaries and native callbacks.
- `src/rag-v1/`: evidence, shared budgets, guarded caches and maintenance.
- `migrations/`: 28 ordered, additive schema migrations.
- `agents/livekit/`: hosted Python voice agent and locked build context.
- `services/faiss/`: authenticated native PDF/FAISS service and pinned dependencies.
- `scripts/`: operator utilities; review before running because some change remote configuration.
- `tests/`: historical local suites, retained for review; not the current acceptance gate.
- `bridge/live_status.py`: legacy local-bridge inspection utility; it requires private local state and is not part of hosted startup.

See [architecture](docs/ARCHITECTURE.md), [handoff](AGENT_HANDOFF.md) and [repository preparation](docs/REPOSITORY_PREPARATION.md). The full operational handoff remains local at `.local/private/AGENT_HANDOFF.full.md` and is ignored by Git. No license is asserted by this preparation; the repository owner must choose any distribution license.
