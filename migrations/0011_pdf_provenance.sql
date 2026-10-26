-- Inactive physical-page metadata, scoped to one published evidence generation.
-- Deletion uses the explicit maintenance primitive until lifecycle integration.
CREATE TABLE evidence_pdf_provenance (
 owner TEXT NOT NULL, dataset TEXT NOT NULL, file_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>0), generation TEXT NOT NULL,
 fingerprint TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_byte_size INTEGER NOT NULL,
 text_sha256 TEXT NOT NULL,
 page_count INTEGER NOT NULL CHECK(page_count BETWEEN 1 AND 64),
 parser_version TEXT NOT NULL, page_map_json TEXT NOT NULL,
 manifest_sha256 TEXT NOT NULL,
 PRIMARY KEY(owner,dataset,file_id)
);
