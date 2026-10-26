# Repository preparation

Prepared 24 October 2026 as a clean source copy. The original installation is unchanged.

> Consolidated into the working tree on 26 October 2026: this checkout is now both the local installation and the Git repository. This file is retained as preparation history.

Included: Worker source, SQL migrations, historical suites, hosted voice/native source and pinned dependencies, operator utility code, configuration examples and current setup/architecture notes.

Excluded: actual Wrangler/LiveKit configuration, secret files, dependencies/venvs, generated binding types, build/runtime state, private evidence, raw operational handoffs/docs, screenshots, transcripts, user documents, databases and local backups. The original operational files remain with the installation.

Export-only portability changes:

- Python voice/native callback origins use WORKER_BASE_URL with exact-origin validation and an example.invalid default; Docker contexts include worker_endpoint.py.
- Production-origin literals in a historical Python fixture become a non-production example origin.
- Local Python scripts use the selected Python interpreter rather than a workstation venv path.
- The Wrangler example contains placeholders, an empty additional-number list and a disabled scheduler. Actual configuration is ignored.
- Local/account-specific READMEs are replaced with setup notes grounded in the copied source.
- Redundant blank lines at the end of source files are trimmed in the export; Git normalizes text line endings to LF.

These portability changes are local to this export. They have not been deployed or qualified by live application tests. Tracked source templates intentionally contain no credentials, recipient list or production callback target.

Preparation checks passed: JavaScript syntax, Python AST parsing without imports, source-copy SHA256 comparison and a Wrangler dry build using placeholder configuration. The export was scanned for known live identifiers and common credential patterns with no matches. These checks do not guarantee that every possible sensitive value is detectable. Historical application suites and live integrations were not exercised.

The prepared repository has no remote, commit or push from this preparation. Credentials and deployment targets must be configured locally before deployment. The original project remains the authoritative live installation; this export is a separate source snapshot.
