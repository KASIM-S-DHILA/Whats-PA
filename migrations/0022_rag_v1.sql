-- Independent serving lane; frozen evidence and memory tables are untouched.
CREATE TABLE rag_sources (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,version INTEGER NOT NULL,
 generation TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('ready','deleted')),
 coverage TEXT NOT NULL CHECK(coverage IN ('complete','partial')),reason TEXT,chunk_count INTEGER NOT NULL,
 embedding_cursor INTEGER NOT NULL DEFAULT 0,cleanup_json TEXT NOT NULL DEFAULT '[]',updated_at TEXT NOT NULL,
 PRIMARY KEY(owner,dataset,file_id)
);
CREATE TABLE rag_passages (
 rowid INTEGER PRIMARY KEY,owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,
 version INTEGER NOT NULL,generation TEXT NOT NULL,passage_id TEXT NOT NULL UNIQUE,position INTEGER NOT NULL,
 title TEXT NOT NULL,heading TEXT NOT NULL,content TEXT NOT NULL,char_start INTEGER NOT NULL,char_end INTEGER NOT NULL,
 UNIQUE(owner,dataset,file_id,generation,position)
);
CREATE INDEX rag_passages_source ON rag_passages(owner,dataset,file_id,generation,position);
CREATE VIRTUAL TABLE rag_fts USING fts5(title,heading,content,tokenize="unicode61 remove_diacritics 0 categories 'L* N* M* Co'");
CREATE TABLE rag_guards(nonce TEXT NOT NULL,valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE rag_ingest_state(owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,error_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner,dataset,file_id));
CREATE TABLE rag_cache(cache_key TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX rag_cache_expiry ON rag_cache(expires_at);
CREATE TABLE rag_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL DEFAULT 0);
CREATE TABLE rag_context(owner TEXT NOT NULL,channel TEXT NOT NULL,context_key TEXT NOT NULL,value_json TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(owner,channel,context_key));
CREATE TABLE rag_documents(file_id TEXT PRIMARY KEY,owner TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,page_map_json TEXT NOT NULL DEFAULT '[]',warnings_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL);
CREATE TABLE rag_vectors(owner TEXT NOT NULL,dataset TEXT NOT NULL,passage_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,generation TEXT NOT NULL,position INTEGER NOT NULL,vector_json TEXT NOT NULL);
CREATE INDEX rag_vectors_source ON rag_vectors(owner,dataset,file_id,generation);
CREATE TABLE rag_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0);
INSERT INTO rag_revision(id,revision) VALUES(1,0);
CREATE TABLE rag_graphs(owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,graph_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL,PRIMARY KEY(owner,dataset,file_id));
