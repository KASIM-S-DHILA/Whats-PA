-- Isolated PDF-derived evidence lifecycle. No scheduler or live route.
CREATE TABLE evidence_pdf_lifecycle (
 owner TEXT NOT NULL, dataset TEXT NOT NULL, file_id TEXT NOT NULL,
 epoch INTEGER NOT NULL CHECK(epoch>0), request_epoch INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('processing','ready','unavailable','failed','deleting','deleted')),
 source_sha256 TEXT NOT NULL, attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 fingerprint TEXT, source_version INTEGER, generation TEXT, reason TEXT,
 PRIMARY KEY(owner,dataset,file_id)
);
