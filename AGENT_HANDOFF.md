# Source handoff

This is a commit-ready source snapshot prepared on 24 October 2026. It is not a deployed clone or a complete operational-history export.

- Worker entry: src/chat-recovery-v1/worker.js. Owner routing: src/owners.js. Scheduler: src/chat-recovery-v1/owner-scheduler.js.
- Schema: migrations 0001 through 0028. Existing private data is not bundled.
- Chat, private file storage/delivery, paged PDF retrieval/summaries, reminders and signed voice tools are implemented.
- Most runtime JS, all SQL migrations and dependency pins are copied from the working source. The Python callback origin is made portable with WORKER_BASE_URL; Docker contexts include its helper. See docs/REPOSITORY_PREPARATION.md for export-only changes.
- The live installation has accepted real chat replies from the primary and an additional owner. Broader multi-owner document/foreign-ID, reminder, call/summary, upload-recovery and read-cost qualification remains pending. Do not claim a complete isolation/security certification.
- Historical test suites are included but were not run during preparation. Static checks and a dry build do not qualify production behavior.
- Memory/shadow/graph expansion remains disabled in the example configuration. The legacy singleton native FAISS snapshot remains primary-only; other owners retain owned Vectorize/FTS retrieval and per-file native PDF operations.
- Global model budgets are shared. Broad maintenance is bounded and can take multiple scheduled slots. Ready-media discovery still has historical-scan limitations; scheduler gating limits unnecessary invocation.

Private deployment IDs, phone numbers, operational handoffs, user payloads, frozen evidence and backups remain in the original installation and are excluded here. A fresh operator must provision their own targets and secrets before deployment.
