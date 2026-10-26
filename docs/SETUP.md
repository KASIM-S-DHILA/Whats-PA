# Deployment setup

## Worker

The project uses ES modules and Node.js 22+. Install pinned dependencies with npm ci. Copy the example Wrangler file to the ignored actual configuration and replace every YOUR_* placeholder. Provision the D1 database, two Vectorize indexes and private Supabase bucket matching the configured bindings. Keep the existing migration order 0001-0028. In an existing checkout, do not overwrite the ignored local `.dev.vars` or `wrangler.chat.jsonc`; the copy step is only for a fresh clone.

Fill local .dev.vars from its empty example. Required deployed secrets are META_VERIFY_TOKEN, META_APP_SECRET, META_ACCESS_TOKEN, ALLOWED_SENDER, SUPABASE_KEY, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, VOICE_BRIDGE_SECRET and RAG_INDEX_SECRET for their enabled features. Store deployed values with Wrangler's secret store, never in committed vars or command arguments. The primary owner is the existing ALLOWED_SENDER secret; additional exact international digits-only senders go in the ALLOWED_SENDERS JSON-array string.

After reviewing the chosen account/configuration, apply local migrations with npm run db:migrate:local, then use npm run dev only when external credentials and permitted outbound behavior are understood. The explicit production commands are npm run db:migrate:remote and npm run deploy; neither was run by repository preparation.

Configure Meta's webhook URL to your Worker /webhook endpoint with the verification secret. Meta test numbers additionally require recipient registration/verification in the app's WhatsApp API Setup/API Testing page. Adding an application allowlist entry alone does not satisfy Meta's test-recipient restriction (131030).

Background work is off in the example: set SCHEDULER_ENABLED to true and triggers.crons to ["* * * * *"] only after database/service setup and reviewing overdue jobs/reminders. Broad cleanup runs at 15-minute UTC boundaries; batch backlogs can take multiple slots. Active upload alarms use five-second recovery checks.

## Voice and native PDF services

The LiveKit image uses Python 3.13 and uv.lock. Copy agents/livekit/livekit.example.toml to the ignored livekit.toml and select your own project/agent. Configure WORKER_BASE_URL, GOOGLE_API_KEY and VOICE_BRIDGE_SECRET in the service's private environment. The Worker and voice agent must share the bridge secret. LiveKit Cloud injects its runtime credentials; local sessions need their own LiveKit settings. The configured agent name is whats-voice.

The native image uses services/faiss/requirements.txt. Set WORKER_BASE_URL to the same HTTPS Worker origin and supply the dedicated RAG_INDEX_SECRET privately. The Worker uses that shared key for native requests and callbacks. WORKER_BASE_URL defaults to an example.invalid host in source checkouts so a copied service cannot call the original installation. Set RAG_FAISS_URL in your local Worker configuration to the native service HTTPS root. The two secrets RAG_INDEX_SECRET and VOICE_BRIDGE_SECRET serve different protocols.

## Verification

Syntax checks, static migration plans and Wrangler dry builds are safe preparation checks. Live messaging, private uploads, reminder delivery and calls require real owner-driven manual evaluation. No automated app/model/retrieval probes, synthetic traffic, failed-job resets or send replay should be run without new explicit authorization. Existing suites and optional operator utilities are not proof of current production behavior.
