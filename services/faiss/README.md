# Native PDF and FAISS service

Docker build context for authenticated native PDF processing and vector retrieval. Configure WORKER_BASE_URL and a private RAG_INDEX_SECRET matching the Worker. The process defaults to PORT=7860; the Worker needs an HTTPS service origin. requirements.txt pins dependencies and the Dockerfile pins the tokenizer revision.

Endpoints include /health and authenticated /search, /extract-pdf, /pdf-upload, /pdf-batch, /token-count, /pdf-fast-start and /pdf-fast-search. Per-file tasks/matrices are fenced by file ID, generation and source hash; the Worker remains the owner/source authority. The legacy singleton snapshot is primary-only. Tokenizer cache and PDF/vector runtime storage are not part of Git.

render.yaml is an optional deployment example, not an executed deployment. No cloud resources, model requests, PDF processing or account changes were made by repository preparation. See ../../docs/SETUP.md and ../../AGENT_HANDOFF.md.
