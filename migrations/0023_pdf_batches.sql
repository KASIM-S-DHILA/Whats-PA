-- New paged lane; existing source generations and frozen evidence remain untouched.
CREATE TABLE rag_pdf_jobs (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,source_hash TEXT NOT NULL,generation TEXT NOT NULL,
 state TEXT NOT NULL, page_cursor INTEGER NOT NULL DEFAULT 0,total_pages INTEGER NOT NULL DEFAULT 0,
 chunk_count INTEGER NOT NULL DEFAULT 0,embedding_cursor INTEGER NOT NULL DEFAULT 0,text_chars INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,error_code TEXT,updated_at INTEGER NOT NULL,
 PRIMARY KEY(owner,dataset,file_id)
);
CREATE TABLE rag_pdf_pages (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,page INTEGER NOT NULL,
 text TEXT NOT NULL,text_hash TEXT NOT NULL,tokens INTEGER NOT NULL,readable INTEGER NOT NULL,
 PRIMARY KEY(owner,dataset,file_id,generation,page)
);
CREATE TABLE rag_pdf_chunks (
 rowid INTEGER PRIMARY KEY,owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,
 position INTEGER NOT NULL,page INTEGER NOT NULL,char_start INTEGER NOT NULL,char_end INTEGER NOT NULL,content TEXT NOT NULL,
 UNIQUE(owner,dataset,file_id,generation,position)
);
CREATE VIRTUAL TABLE rag_pdf_fts USING fts5(content,tokenize="unicode61 remove_diacritics 0 categories 'L* N* M* Co'");
CREATE TABLE rag_pdf_summaries (
 owner TEXT NOT NULL,dataset TEXT NOT NULL,file_id TEXT NOT NULL,generation TEXT NOT NULL,job_id TEXT PRIMARY KEY,
 question TEXT NOT NULL,state TEXT NOT NULL,level INTEGER NOT NULL DEFAULT 0,cursor INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,error_code TEXT,answer TEXT,updated_at INTEGER NOT NULL
);
CREATE TABLE rag_pdf_summary_parts (
 job_id TEXT NOT NULL,level INTEGER NOT NULL,position INTEGER NOT NULL,page_first INTEGER NOT NULL,page_last INTEGER NOT NULL,
 text TEXT NOT NULL,tokens INTEGER NOT NULL,PRIMARY KEY(job_id,level,position)
);
