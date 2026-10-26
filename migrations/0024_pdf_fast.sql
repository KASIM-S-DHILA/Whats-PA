-- Fast ingestion coordinates only new owner uploads; no old jobs are reset.
CREATE TABLE rag_pdf_fast_jobs (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,source_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,
 started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,finished_at INTEGER,ready_ms INTEGER,extract_ms INTEGER,error_code TEXT,
 total_pages INTEGER NOT NULL DEFAULT 0,total_chunks INTEGER NOT NULL DEFAULT 0,vectorize_count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner,dataset,file_id,generation)
);
CREATE TABLE rag_pdf_fast_parts (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,
 kind TEXT NOT NULL,position INTEGER NOT NULL,count INTEGER NOT NULL,fingerprint TEXT NOT NULL,
 state TEXT NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,dataset,file_id,generation,kind,position)
);
