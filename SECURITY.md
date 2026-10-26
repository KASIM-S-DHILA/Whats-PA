# Security policy

## Supported versions

Only the `main` branch is supported.

## Reporting a vulnerability

This repository is private. Use GitHub private vulnerability reporting for this repository. Do not open a public issue, and do not include credentials, tokens, phone numbers, user documents, raw messages or deployment identifiers in a report.

Include the affected component (Worker, D1, Supabase storage, Vectorize/Workers AI, LiveKit agent or native PDF service), reproduction scope and impact. The owner will acknowledge the report and coordinate a fix.

## Secret handling

- Never commit `.dev.vars`, actual `wrangler.chat.jsonc`, `agents/livekit/livekit.toml`, service `.env` files, evidence, private operational docs or generated build state.
- Store deployed values in Wrangler's secret store, never in committed vars or command arguments.
- If a secret is exposed, rotate it first. Deleting a file or commit is not sufficient because Git history and caches may retain it.
- Do not run live messaging, uploads, calls, model probes, failed-job resets, send replay or synthetic traffic without explicit owner authorization.
