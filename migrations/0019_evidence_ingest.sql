-- Bookkeeping for the evidence ingest driver. One row per file that could not be published yet or never can be.
-- A published file has no row here. A row is revisited only when the catalog row changes or while its state is retry.
CREATE TABLE evidence_ingest_state (
 owner TEXT NOT NULL,
 dataset TEXT NOT NULL,
 file_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('retry','failed','unsupported')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 error_code TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(owner,dataset,file_id)
);
