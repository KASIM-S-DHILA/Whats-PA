// Evidence ingest driver (production RAG first slice). Isolated: run only from deploy/memory-entry.js, OFF unless EVIDENCE_ENABLED and
// EVIDENCE_INGEST_ENABLED are 'true'. It moves files that extraction already marked ready into the passage index, in bounded steps:
// publish passages, embed passages when the vector binding exists, finish vector cleanup, and tombstone sources whose catalog row is gone.
// It never reads files, calls extraction or OCR, answers questions or writes memory. Scanned documents without extracted text are never
// published, so they stay unsearchable instead of being claimed as indexed.
import {checkOwner, dataset, ToolError} from '../search.js';
import {publishEvidenceSource, deleteEvidenceSource, indexEvidenceVectors, cleanupEvidenceVectors} from './evidence.js';

const fail = code => { throw new ToolError(code); };
export const MAX_INGEST_ATTEMPTS = 3;
const UNSUPPORTED = new Set(['invalid_evidence_text', 'evidence_chunk_limit', 'evidence_source_unavailable', 'invalid_evidence_boundary', 'evidence_cleanup_required']);
const stamp = now => { if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('invalid_ingest_clock'); return now.toISOString(); };
const code = error => error instanceof ToolError || typeof error?.code === 'string' ? error.code : 'ingest_step_failed';

function enabled(env) { if (env.RAG_ENABLED !== 'true' || env.RAG_ENABLED !== 'true') fail('ingest_disabled'); }

async function recordFailure(env, owner, fileId, errorCode, at) {
  const unsupported = UNSUPPORTED.has(errorCode);
  await env.DB.prepare(`INSERT INTO rag_ingest_state(owner,dataset,file_id,state,attempts,error_code,updated_at) VALUES(?,?,?,?,1,?,?)
    ON CONFLICT(owner,dataset,file_id) DO UPDATE SET attempts=CASE WHEN excluded.state='unsupported' THEN rag_ingest_state.attempts ELSE rag_ingest_state.attempts+1 END,
    state=CASE WHEN excluded.state='unsupported' THEN 'unsupported' WHEN rag_ingest_state.attempts+1>=? THEN 'failed' ELSE 'retry' END,error_code=excluded.error_code,updated_at=excluded.updated_at`)
    .bind(owner, dataset(env), fileId, unsupported ? 'unsupported' : 'retry', errorCode, at, MAX_INGEST_ATTEMPTS).run();
  return unsupported ? 'unsupported' : 'retry';
}

export async function runEvidenceIngest(env, owner, {now = new Date(), publishLimit = 1, indexLimit = 1, pdfOnly = false} = {}) {
  checkOwner(env, owner); enabled(env); const at = stamp(now);
  if (!Number.isInteger(publishLimit) || publishLimit < 1 || publishLimit > 10 || !Number.isInteger(indexLimit) || indexLimit < 1 || indexLimit > 5 || typeof pdfOnly !== 'boolean') fail('invalid_ingest_limit');
  const ds = dataset(env), out = {published: 0, unchanged: 0, unsupported: 0, retry: 0, failed: 0, indexed: 0, vectorStatus: env.AI && env.RAG_VECTORS ? 'available' : 'unavailable', tombstoned: 0, cleaned: 0, errors: []};

  // 1. Publish. The updated_at comparisons are a cheap pre-filter, publishEvidenceSource decides with the real fingerprint.
  const candidates = (await env.DB.prepare(`SELECT c.file_id AS file_id,COALESCE(s.version,0) AS version FROM file_catalog c
    LEFT JOIN rag_sources s ON s.owner=c.owner AND s.dataset=c.dataset AND s.file_id=c.file_id
    LEFT JOIN rag_ingest_state i ON i.owner=c.owner AND i.dataset=c.dataset AND i.file_id=c.file_id
    WHERE c.owner=? AND c.dataset=? AND c.extraction_status='ready' AND c.extraction_method IS NOT 'metadata' AND c.extraction_method IS NOT 'pdf_text:paged' AND length(trim(c.extracted_text))>0 ${pdfOnly?"AND c.mime_type='application/pdf' AND c.index_state='ready'":''}
    AND (s.file_id IS NULL OR (s.state='ready' AND c.updated_at>s.updated_at))
    AND (i.file_id IS NULL OR c.updated_at>i.updated_at OR i.state='retry') ORDER BY CASE WHEN c.mime_type='application/pdf' THEN 0 WHEN c.kind='document' THEN 1 WHEN c.kind='note' THEN 2 ELSE 3 END,c.updated_at,c.file_id LIMIT ?`).bind(owner, ds, publishLimit).all()).results;
  for (const c of candidates) {
    try {
      const r = await publishEvidenceSource(env, owner, {fileId: c.file_id, expectedVersion: c.version});
      out[r.outcome === 'published' ? 'published' : 'unchanged']++;
      await env.DB.prepare('DELETE FROM rag_ingest_state WHERE owner=? AND dataset=? AND file_id=?').bind(owner, ds, c.file_id).run();
    } catch (error) {
      const state = await recordFailure(env, owner, c.file_id, code(error), at);
      const row = await env.DB.prepare('SELECT state FROM rag_ingest_state WHERE owner=? AND dataset=? AND file_id=?').bind(owner, ds, c.file_id).first();
      out[row?.state === 'failed' ? 'failed' : state]++;
    }
  }

  // 2. Embed. Rebuild mode indexes only PDFs, in batches of three under the existing background cap.
  if (out.vectorStatus === 'available') {
    const pending = (await env.DB.prepare(pdfOnly?`SELECT s.file_id,s.version FROM rag_sources s
      JOIN file_catalog c ON c.owner=s.owner AND c.dataset=s.dataset AND c.file_id=s.file_id
      LEFT JOIN rag_ingest_state i ON i.owner=s.owner AND i.dataset=s.dataset AND i.file_id=s.file_id
      WHERE s.owner=? AND s.dataset=? AND s.state='ready' AND c.mime_type='application/pdf' AND c.index_state='ready' AND s.embedding_cursor<s.chunk_count
      AND (i.file_id IS NULL OR c.updated_at>i.updated_at OR i.state='retry') ORDER BY s.updated_at,s.file_id LIMIT ?`:
      `SELECT file_id,version FROM rag_sources WHERE owner=? AND dataset=? AND state='ready' AND embedding_cursor<chunk_count ORDER BY updated_at,file_id LIMIT ?`).bind(owner, ds, indexLimit).all()).results;
    for (const s of pending) {
      try {
        const r = await indexEvidenceVectors(env, owner, {fileId: s.file_id, expectedVersion: s.version, batchSize: pdfOnly ? 3 : 16});
        if (r.outcome === 'ready' || r.outcome === 'pending') {
          out.indexed++;
          if (pdfOnly) await env.DB.prepare('DELETE FROM rag_ingest_state WHERE owner=? AND dataset=? AND file_id=?').bind(owner, ds, s.file_id).run();
        }
      } catch (error) {
        const problem=code(error);
        if (problem !== 'evidence_stale') {
          out.errors.push({step: 'index', code: problem});
          if (pdfOnly && !['rag_background_budget','rag_daily_budget'].includes(problem)) {
            await recordFailure(env, owner, s.file_id, problem, at);
            const failure=await env.DB.prepare('SELECT state FROM rag_ingest_state WHERE owner=? AND dataset=? AND file_id=?').bind(owner, ds, s.file_id).first();
            out[failure?.state==='failed'?'failed':'retry']++;
          }
        }
      }
    }
  }

  // 3. Vector cleanup left behind by republished or tombstoned sources.
  const dirty = (await env.DB.prepare(pdfOnly?`SELECT s.file_id FROM rag_sources s JOIN file_catalog c ON c.owner=s.owner AND c.dataset=s.dataset AND c.file_id=s.file_id
    WHERE s.owner=? AND s.dataset=? AND c.mime_type='application/pdf' AND s.cleanup_json<>'[]' LIMIT 1`:
    `SELECT file_id FROM rag_sources WHERE owner=? AND dataset=? AND cleanup_json<>'[]' LIMIT 2`).bind(owner, ds).all()).results;
  for (const s of dirty) {
    try { const r = await cleanupEvidenceVectors(env, owner, {fileId: s.file_id}); if (r.outcome === 'complete') out.cleaned++; }
    catch (error) { out.errors.push({step: 'cleanup', code: code(error)}); }
  }

  if (pdfOnly) return out; // Rebuild retention/tombstones already run in runRagMaintenance.
  // 4. Tombstone sources whose catalog row no longer exists. A merely unusable row is left alone: retrieval already hides stale sources.
  const gone = (await env.DB.prepare(`SELECT s.file_id AS file_id,s.version AS version FROM rag_sources s LEFT JOIN file_catalog c ON c.owner=s.owner AND c.dataset=s.dataset AND c.file_id=s.file_id
    WHERE s.owner=? AND s.dataset=? AND s.state='ready' AND c.file_id IS NULL LIMIT 3`).bind(owner, ds).all()).results;
  for (const s of gone) {
    try { await deleteEvidenceSource(env, owner, {fileId: s.file_id, expectedVersion: s.version}); out.tombstoned++; }
    catch (error) { out.errors.push({step: 'tombstone', code: code(error)}); }
  }
  return out;
}

// Counts only. Lets an operator see how much of the usable catalog is actually searchable, and why the rest is not.
export async function evidenceIngestStatus(env, owner) {
  checkOwner(env, owner); enabled(env); const ds = dataset(env);
  const one = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first('n')) ?? 0;
  const usable = await one(`SELECT COUNT(*) AS n FROM file_catalog WHERE owner=? AND dataset=? AND extraction_status='ready' AND extraction_method IS NOT 'metadata' AND length(trim(extracted_text))>0`, owner, ds);
  const published = await one(`SELECT COUNT(*) AS n FROM rag_sources WHERE owner=? AND dataset=? AND state='ready'`, owner, ds);
  const unembedded = await one(`SELECT COUNT(*) AS n FROM rag_sources WHERE owner=? AND dataset=? AND state='ready' AND embedding_cursor<chunk_count`, owner, ds);
  const states = (await env.DB.prepare('SELECT state,COUNT(*) AS n FROM rag_ingest_state WHERE owner=? AND dataset=? GROUP BY state').bind(owner, ds).all()).results;
  const not = Object.fromEntries(states.map(r => [r.state, r.n]));
  return {usableFiles: usable, published, awaitingEmbedding: unembedded, retry: not.retry ?? 0, failed: not.failed ?? 0, unsupported: not.unsupported ?? 0, vectorBinding: Boolean(env.AI && env.RAG_VECTORS)};
}
