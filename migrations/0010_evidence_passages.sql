-- Parallel passage index. Existing file search, vectors and delivery remain unchanged.
CREATE TABLE evidence_sources (
 owner TEXT NOT NULL, dataset TEXT NOT NULL, file_id TEXT NOT NULL,
 version INTEGER NOT NULL, generation TEXT NOT NULL, fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('ready','deleted')),
 coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')),
 reason TEXT, chunk_count INTEGER NOT NULL, embedding_cursor INTEGER NOT NULL DEFAULT 0,
 cleanup_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
 PRIMARY KEY(owner,dataset,file_id)
);
CREATE TABLE evidence_passages (
 rowid INTEGER PRIMARY KEY, owner TEXT NOT NULL, dataset TEXT NOT NULL,
 file_id TEXT NOT NULL, version INTEGER NOT NULL, generation TEXT NOT NULL,
 passage_id TEXT NOT NULL UNIQUE, position INTEGER NOT NULL,
 title TEXT NOT NULL, heading TEXT NOT NULL, content TEXT NOT NULL,
 char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
 UNIQUE(owner,dataset,file_id,generation,position)
);
CREATE INDEX evidence_passages_source ON evidence_passages(owner,dataset,file_id,generation,position);
CREATE VIRTUAL TABLE evidence_fts USING fts5(title,heading,content,
 tokenize="porter unicode61 remove_diacritics 0 categories 'L* N* M* Co'");
-- Explicit same-transaction FTS maintenance avoids trigger-loader assumptions.
CREATE TABLE evidence_guards (nonce TEXT NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
