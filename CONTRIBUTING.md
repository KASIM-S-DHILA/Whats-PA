# Contributing

This is a private repository. Coordinate with the owner before changing deployment behavior or running live checks.

## Local checks

1. Use Node.js 22 or newer and run `npm ci`.
2. Keep the ignored local `.dev.vars`, `wrangler.chat.jsonc`, `agents/livekit/livekit.toml`, `.local/` and `evidence/` in place. Copy the examples only on a fresh checkout.
3. Run `npm test` for the current offline checks.
4. Run `npm run build:example` for a safe Wrangler dry build with the placeholder configuration.
5. Run `npm run build` for a local dry build against your ignored configuration.

The historical suites in `tests/*.historical.mjs` target the pre-`chat-recovery-v1` modules. They are review-only and are not part of the acceptance gate.

## Change rules

- Preserve owner isolation, signature validation, source/current checks, leases, durable retries and uncertain-send handling.
- Never commit credentials, actual deployment configuration, phone allowlists, evidence, raw messages or user documents.
- Do not run live messaging, uploads, calls, model probes or synthetic traffic without explicit owner authorization.
- Keep migrations ordered and additive.
- Use a concise, imperative commit message and describe the verification you ran.
- Report security issues as described in [SECURITY.md](SECURITY.md).
