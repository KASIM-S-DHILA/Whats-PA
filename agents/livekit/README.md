# Hosted voice agent

Build context for the whats-voice LiveKit agent. Python 3.13 and uv.lock pin dependencies. Set WORKER_BASE_URL to your own Worker HTTPS origin; configure GOOGLE_API_KEY and VOICE_BRIDGE_SECRET privately. Copy livekit.example.toml to the ignored livekit.toml before selecting your own LiveKit project.

The Worker authenticates call metadata and resolves each call owner from its stored session. Docker includes only the active agent, signed transport, archive callback, origin helper and pinned dependencies. The memory variant and historical tests are retained for review and are not enabled by the active Dockerfile.

See ../../docs/SETUP.md. Handset calls and owner isolation require manual evaluation; repository preparation did not run a live call or deploy an agent.
