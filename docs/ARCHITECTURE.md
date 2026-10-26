# Runtime architecture

Meta signs webhook bodies. The Worker validates HMAC, WABA and business-number identity, then resolves each message sender against the configured owners. Unknown senders are silently acknowledged before content persistence or model work. Each accepted event receives a fresh owner environment; callers and model arguments cannot choose an owner.

Commands, context, proposals, documents and reminders are scoped through that owner or a validated parent/lease. Private objects and Vectorize namespaces use owner-derived identities. Library answers validate source generation/hash/current catalog state and citations. Primary data is neither migrated nor shared when another number is allowed.

PDF jobs retain page/chunk cursors, source hashes and leases. A native service processes bounded work and sends authenticated callbacks; callback ownership comes from stored matching jobs, not a caller-supplied owner. Upload Durable Objects persist the owner/message pair and check their deterministic object identity before resuming work.

LiveKit call metadata binds signed call ID and room. Signed tools and archive callbacks derive owner from the immutable call session before access or delivery. Per-file native matrices use owner-derived file IDs plus generation/source hash. The older singleton FAISS snapshot stays primary-only; additional owners use owned Vectorize/FTS paths for library retrieval.

The scheduler performs indexed owner metadata discovery, rotates owner order and isolates failures by lane. Empty owners skip heavy minute work; global expiry is run once, and broad owner cleanup runs at 15-minute slots. Inference and summary budgets remain globally shared. Sends distinguish accepted, failed and uncertain outcomes; an uncertain external send is not automatically replayed.

This describes implemented controls, not a guarantee of security, complete recall, latency or exactly-once delivery. Consult AGENT_HANDOFF.md for manual qualification gaps.
