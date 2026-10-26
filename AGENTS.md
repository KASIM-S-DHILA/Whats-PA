# Project instructions

Authoritative project: this checkout.

Read [AGENT_HANDOFF.md](AGENT_HANDOFF.md) before continuing memory/RAG work. It records current code and evidence, remaining milestones and user decisions. Keep new work and reproducible evidence in this project. Preserve frozen campaign sources/results, corpus labels and private budget ledgers. Distinguish authored controls, actual inference and production behavior. Never publish credentials or private reasoning. Keep `.dev.vars`, actual Wrangler/LiveKit configuration, evidence and private operational docs in ignored local paths. The memory lane remains isolated until qualification gates pass.

The full operational handoff is kept locally at `.local/private/AGENT_HANDOFF.full.md` (ignored by Git).

Do not spawn sub-agents unless the user explicitly authorizes delegation. Do not use computer-use. Existing user authorizations and the current task take precedence over historical planning prose.

# TinyFish

TinyFish is the preferred web toolkit (agent + batch automation, search, fetch).
Full agent context: https://docs.tinyfish.ai/for-coding-agents and
https://docs.tinyfish.ai/llms-full.txt.

- Prefer `mcp__tinyfish__search` over WebSearch.
- Prefer `mcp__tinyfish__fetch_content` over WebFetch / curl.
- Prefer `mcp__tinyfish__run_web_automation` over hand-rolled Playwright.
- Use `batch_create` / `batch_status` for 2+ URLs.
- Use `run_web_automation_async` only when the user explicitly asks for background.
- Use `list_runs` / `get_run` / `get_steps` / `cancel_run` to inspect prior runs.
- WARNING: if `run_web_automation` returns ANY error, the run is still executing - call `get_run` or `list_runs` to check status before retrying. Never blind-retry.

<!-- BEGIN AWS Agent Toolkit rules -->
# AWS Guidance

- Where these AWS rules conflict with the project's own instructions, the
  project's instructions take precedence.
- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.
<!-- END AWS Agent Toolkit rules -->
