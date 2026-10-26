# WhatsApp File Assistant

Private, owner-scoped WhatsApp assistant for file storage, PDF questions, reminders and voice calls on Cloudflare Workers.

> Private repository. See [LICENSE](LICENSE). Never commit credentials, live deployment configuration, user documents, raw messages or operational evidence.

## What it does

- Validates Meta webhook signatures and resolves every sender against an exact owner allowlist.
- Stores media in private Supabase storage and keeps metadata, jobs and migrations in D1.
- Answers questions over owned documents and PDFs using Vectorize, Workers AI and a native PDF/FAISS service.
- Searches, delivers and summarizes files, saves notes and runs reminders.
- Hosts LiveKit voice calls with a Python agent and signed, revision-scoped Worker tools.
- Keeps memory and evidence experimental lanes disabled in the example configuration.

## Architecture

| Component | Role |
| --- | --- |
| Cloudflare Worker | Webhook entry, owner routing, chat commands, scheduler, media recovery, call tools |
| D1 | Message/job metadata, file catalog, reminders, retrieval support and ordered migrations |
| Supabase Storage | Private audio, image, video and document objects |
| Vectorize and Workers AI | Owner-scoped retrieval, embeddings and model calls |
| LiveKit and Python agent | Hosted voice calls, transcripts and signed tool requests |
| Native PDF service | Bounded PDF extraction, FAISS retrieval and authenticated callbacks |

The active entrypoint is `src/chat-recovery-v1/worker.js`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the control boundaries and [AGENT_HANDOFF.md](AGENT_HANDOFF.md) for qualification gaps.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/chat-recovery-v1/` | Active webhook, commands, scheduler, call tools, reminders and recovery |
| `src/owners.js` | Exact-number membership and immutable owner environments |
| `src/rag-rebuild/`, `src/rag-v1/` | Owned library retrieval, paged PDFs, native callbacks and budgets |
| `migrations/` | 28 ordered, additive D1 migrations |
| `agents/livekit/` | Hosted Python voice agent and locked build context |
| `services/faiss/` | Authenticated native PDF/FAISS service and pinned dependencies |
| `scripts/` | Operator utilities; review before running because some change remote configuration |
| `tests/current.test.mjs` | Default offline acceptance gate |
| `tests/*.historical.mjs` | Pre-`chat-recovery-v1` suites retained for review only; see [tests/README.md](tests/README.md) |
| `bridge/live_status.py` | Legacy local-bridge inspection utility; it requires private local state and is not part of hosted startup |
| `docs/` | Architecture, deployment setup and repository preparation history |

## Local development

Requires Node.js 22 or newer. The verified local runtime is Node.js 24. Optional voice and native PDF services require Python 3.13.

1. Install pinned dependencies with `npm ci`.
2. On a fresh checkout, copy `wrangler.chat.example.jsonc` to the ignored `wrangler.chat.jsonc` and `.dev.vars.example` to `.dev.vars`. Fill your own Cloudflare resources, Meta IDs, storage/service URLs and local secrets.
3. Apply the local schema with `npm run db:migrate:local`.
4. Start the Worker with `npm run dev`.
5. Run `npm test`.
6. Run `npm run build:example` for a safe placeholder dry build, or `npm run build` against your ignored local configuration.

Existing checkouts should keep the ignored `.dev.vars`, `wrangler.chat.jsonc`, `agents/livekit/livekit.toml`, `.local/`, `evidence/` and private docs in place. Do not copy the examples over a live local configuration. See [docs/SETUP.md](docs/SETUP.md) for Meta, D1, Vectorize, Supabase, LiveKit and native service setup.

## Testing

- `npm test` runs the current offline gate: active module loading, owner isolation, PDF follow-up and rephrase limits, command parsing, safe example configuration/secrets and migration order. It does not contact services or send messages.
- `npm run build:example` compiles the Worker with the placeholder example configuration and is also used by CI.
- `tests/*.historical.mjs` are review-only suites for the pre-`chat-recovery-v1` modules. They are not run by `npm test` and are not evidence of current behavior.
- Do not run live messaging, uploads, calls, model probes or synthetic traffic without explicit owner authorization.

## Deployment

Deployment is manual and owner-controlled. Actual configuration, credentials and allowlists are ignored by Git. Follow [docs/SETUP.md](docs/SETUP.md) before applying remote migrations or deploying.

- `npm run db:migrate:remote` applies migrations to the configured D1 database.
- `npm run deploy` updates the configured Worker.
- CI validates the test gate and the placeholder dry build only; it does not deploy or mutate infrastructure.
- The native PDF service and LiveKit agent are separate hosted components with their own private environment configuration.

## Security and privacy

- Owner isolation is enforced from trusted webhook/session data, not caller or model-supplied arguments.
- Webhook signatures, source/current checks, leases, retries and uncertain-send handling remain mandatory control boundaries.
- `.dev.vars`, actual Wrangler/LiveKit configuration, evidence, private operational docs and generated state are kept out of Git.
- Historical test fixtures are synthetic and must not be replaced with live customer data.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue containing secrets, phone numbers or user payloads.

## Status and limitations

- Chat, private file storage/delivery, paged PDF retrieval/summaries, reminders and signed voice tools are implemented.
- Memory and evidence expansion lanes remain disabled in the example configuration.
- Live behavior requires owner-driven manual evaluation; the current test gate is not a production qualification.
- The historical suites are not a complete acceptance gate.
- No claim is made for complete isolation/security certification, exact recall, latency or exactly-once delivery.

## Contributing

This is a private repository. Coordinate with the owner before changing deployment behavior. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and change rules.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
