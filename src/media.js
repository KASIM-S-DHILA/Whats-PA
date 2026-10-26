import { createHash } from 'node:crypto';
import { acknowledge } from './acknowledge.js';
import { MediaError, uploadVerifiedMedia, deleteObject } from './storage.js';
import { readImage, describeImage } from './vision.js';

const MEDIA_TYPES = new Set(['audio', 'image', 'video', 'document']);
const EXTENSIONS = {
  'audio/aac':'aac', 'audio/amr':'amr', 'audio/mpeg':'mp3', 'audio/mp4':'m4a', 'audio/ogg':'ogg',
  'image/jpeg':'jpg', 'image/png':'png', 'video/mp4':'mp4', 'video/3gpp':'3gp',
  'text/plain':'txt', 'application/json':'json', 'application/pdf':'pdf', 'application/msword':'doc',
  'application/vnd.ms-excel':'xls', 'application/vnd.ms-powerpoint':'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx'
};
const hash = value => createHash('sha256').update(value).digest('hex');
export const isMediaMessage = message => MEDIA_TYPES.has(message.type) ||
  (Array.isArray(message.errors) && message.errors.some(error => error?.code === 131052)) === true;
export const mediaConfigured = env => Boolean(env.SUPABASE_URL && env.SUPABASE_BUCKET && env.SUPABASE_KEY &&
  Number.isSafeInteger(Number(env.MAX_MEDIA_BYTES)) && Number(env.MAX_MEDIA_BYTES) > 0);

export function createMediaStatement(env, message, now) {
  const media = message[message.type];
  const mime = typeof media?.mime_type === 'string' ? media.mime_type.split(';')[0].trim().toLowerCase() : '';
  const key = `owners/${hash(env.ALLOWED_SENDER)}/${hash(message.id)}.${EXTENSIONS[mime] ?? 'bin'}`;
  return env.DB.prepare(`INSERT INTO media_files
    (message_id, sender, media_id, message_type, is_voice_note, filename, bucket, object_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
    .bind(message.id, message.from, typeof media?.id === 'string' ? media.id : '', message.type,
      message.type === 'audio' && media?.voice === true ? 1 : 0,
      typeof media?.filename === 'string' ? media.filename.slice(0,255) : null,
      env.SUPABASE_BUCKET, key, now, now);
}

function normalizeHash(value) {
  if (typeof value !== 'string') throw new MediaError('invalid_hash');
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, 'base64').toString('hex');
  throw new MediaError('invalid_hash');
}
function validateInfo(info, message, env) {
  if (String(info.id) !== message[message.type]?.id) throw new MediaError('media_id_mismatch');
  const size = Number(info.file_size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new MediaError('invalid_size');
  if (size > Number(env.MAX_MEDIA_BYTES)) throw new MediaError('too_large');
  const mime = typeof info.mime_type === 'string' ? info.mime_type : '';
  if (mime.length > 200 || /[\r\n]/.test(mime)) throw new MediaError('invalid_mime');
  const baseMime = mime.split(';')[0].trim().toLowerCase();
  if (!EXTENSIONS[baseMime]) throw new MediaError('unsupported_mime');
  if(baseMime==='application/json'&&message.call_artifact!=='transcript')throw new MediaError('unsupported_mime');
  if ((message.type === 'audio' && !baseMime.startsWith('audio/')) ||
      (message.type === 'image' && !baseMime.startsWith('image/')) ||
      (message.type === 'video' && !baseMime.startsWith('video/')) ||
      (message.type === 'document' && !['application/','text/'].some(prefix => baseMime.startsWith(prefix)))) {
    throw new MediaError('type_mismatch');
  }
  const expected = normalizeHash(info.sha256);
  if (message[message.type]?.sha256 && normalizeHash(message[message.type].sha256) !== expected) {
    throw new MediaError('metadata_hash_mismatch');
  }
  const url = new URL(info.url);
  if (url.protocol !== 'https:' || url.username || url.password ||
      !['lookaside.fbsbx.com'].includes(url.hostname)) throw new MediaError('unsafe_media_url');
  return { ...info, file_size:size, mime_type:mime, sha256:expected };
}

async function downloadMedia(env, message, signal) {
  const id = message[message.type]?.id;
  if (!/^\d{1,40}$/.test(id ?? '')) throw new MediaError('invalid_media_id');
  const headers = { Authorization:`Bearer ${env.META_ACCESS_TOKEN}` };
  for (let attempt = 0; attempt < 2; attempt++) {
    const metadata = await fetch(`https://graph.facebook.com/v26.0/${id}?phone_number_id=${encodeURIComponent(env.META_PHONE_NUMBER_ID)}`, {
      headers, redirect:'manual', signal
    });
    if (!metadata.ok) {
      await metadata.body?.cancel();
      throw new MediaError('media_metadata', metadata.status === 429 || metadata.status >= 500);
    }
    const info = validateInfo(await metadata.json(), message, env);
    const download = await fetch(info.url, { headers, redirect:'manual', signal });
    if (download.ok && download.body) return { info, download };
    await download.body?.cancel();
    if (download.status === 404 && attempt === 0) continue;
    throw new MediaError('media_download', download.status === 404 || download.status === 429 || download.status >= 500);
  }
}

// Storage readiness alone does not mean a document is ready for questions.
const documentStatusSql = `coalesce((SELECT CASE
  WHEN c.index_state='failed' OR p.state='failed' OR f.state='failed' THEN 'failed'
  WHEN c.extraction_status='metadata_only' THEN 'unreadable'
  WHEN c.index_state='ready' AND c.extraction_status='ready' AND
    (c.extraction_method<>'pdf_text:paged' OR (p.state='ready' AND p.total_pages>0
      AND p.page_cursor=p.total_pages AND p.embedding_cursor>=p.chunk_count))
    THEN CASE WHEN c.extraction_method='pdf_text:paged' AND p.chunk_count=0 THEN 'unreadable' ELSE 'ready' END
  ELSE 'pending' END
  FROM file_catalog c
  LEFT JOIN rag_pdf_jobs p ON p.owner=c.owner AND p.dataset=c.dataset AND p.file_id=c.file_id AND p.source_hash=c.sha256
  LEFT JOIN rag_pdf_fast_jobs f ON f.owner=p.owner AND f.dataset=p.dataset AND f.file_id=p.file_id AND f.generation=p.generation AND f.source_hash=p.source_hash
  WHERE c.message_id=m.message_id AND c.owner=m.sender AND c.dataset=? AND c.sha256=m.sha256),'pending')`;

async function replyForMedia(env, id) {
  const row = await env.DB.prepare(`SELECT m.*,i.payload_json,
    ${documentStatusSql} AS document_state FROM media_files m JOIN inbound_messages i ON i.message_id=m.message_id
    WHERE m.message_id=? AND m.sender=?`)
    .bind(env.FILE_DATASET || 'live',id, env.ALLOWED_SENDER).first();
  if (!row || !['ready','rejected','failed'].includes(row.state)) return;
  // A new voice command owns this message's single reply, including failures.
  if(env.VOICE_NOTE_ASSISTANT_ENABLED==='true'&&await env.DB.prepare("SELECT 1 FROM command_jobs WHERE message_id=? AND owner=? AND kind='voice_assistant'").bind(id,env.ALLOWED_SENDER).first())return;
  const payload=JSON.parse(row.payload_json),artifact=payload.call_artifact;
  const processedDocument=row.state==='ready'&&row.message_type==='document'&&!artifact&&env.AI&&env.FILES;
  if(processedDocument&&row.document_state==='pending')return;
  const claimed = await env.DB.prepare(`UPDATE inbound_messages SET ack_state = 'sending', ack_updated_at = ?
    WHERE message_id = ? AND sender = ? AND ack_state = 'pending'`)
    .bind(new Date().toISOString(), id, env.ALLOWED_SENDER).run();
  if (claimed.meta.changes !== 1) return;
  let body;
  if (row.state === 'ready') {
    body = row.is_voice_note ? 'Voice note saved.' :
      ({audio:'Audio file saved.',image:'Image saved.',video:'Video saved.',document:'Document saved.'})[row.message_type];
    if (row.message_type === 'image') {
      const image = await readImage(env, row);
      if (image) {
        const described = await describeImage(env, { ...image, caption: typeof payload.image?.caption === 'string' ? payload.image.caption : null });
        if (described.state === 'answered') body = described.text;
      }
    }
    if(processedDocument)body=row.document_state==='ready'?'Document saved and processed. You can ask me questions about it.':
      row.document_state==='unreadable'?'Document saved, but I could not extract readable text from it.':
        'Document saved, but processing stopped before completion. It is not fully ready for questions.';
    if(artifact)body='Call '+artifact+' saved. ID: '+hash('file:'+env.ALLOWED_SENDER+':'+id).slice(0,16);
  } else if (row.error_code === 'too_large') {
    body = `I can save files up to ${Math.floor(Number(env.MAX_MEDIA_BYTES) / (1024 * 1024))} MB for now. Please send a smaller file.`;
  } else {
    body = 'I could not save this attachment. Please try sending it again.';
  }
  await acknowledge(env, id, body);
}

export async function notifyDocumentProcessed(env,fileId) {
  // Notification delivery must never change a committed processing result.
  try {
    const file=await env.DB.prepare('SELECT message_id FROM file_catalog WHERE file_id=? AND owner=? AND dataset=?')
      .bind(fileId,env.ALLOWED_SENDER,env.FILE_DATASET || 'live').first();
    if(file)await replyForMedia(env,file.message_id);
  } catch { console.warn(JSON.stringify({event:'document_ready_notification',state:'deferred'})); }
}

export async function processMedia(env, id) {
  if (!mediaConfigured(env)) return;
  const token = crypto.randomUUID();
  const time = Date.now();
  const claim = await env.DB.prepare(`UPDATE media_files SET state = 'processing', attempts = attempts + 1,
    lease_token = ?, lease_until = ?, updated_at = ? WHERE message_id = ? AND sender = ? AND attempts < 3
    AND ((state = 'pending' AND next_attempt_at <= ?) OR (state = 'processing' AND lease_until <= ?))
    AND (SELECT count(*) FROM media_files active WHERE active.sender=? AND active.state='processing' AND active.lease_until>?)<3`)
    .bind(token, time + 90000, new Date().toISOString(), id, env.ALLOWED_SENDER, time, time,env.ALLOWED_SENDER,time).run();
  if (claim.meta.changes !== 1) { await replyForMedia(env,id); return; }
  const row = await env.DB.prepare(`SELECT m.*, i.payload_json FROM media_files m
    JOIN inbound_messages i ON i.message_id = m.message_id WHERE m.message_id = ? AND m.lease_token = ?`)
    .bind(id,token).first();
  if (!row) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(),env.RAG_PDF_BATCHES_ENABLED==='true'&&row.message_type==='document'?60000:18000);
  let uploadStarted = false;
  try {
    const message = JSON.parse(row.payload_json);
    if ((Array.isArray(message.errors) && message.errors.some(error => error?.code === 131052))) throw new MediaError('too_large');
    const { info, download } = await downloadMedia(env,message,controller.signal);
    uploadStarted = true;
    const saved = await uploadVerifiedMedia(env,download,info,row.object_key,controller);
    const result = await env.DB.prepare(`UPDATE media_files SET state = 'ready', mime_type = ?, byte_size = ?, sha256 = ?,
      lease_until = 0, lease_token = NULL, error_code = NULL, updated_at = ? WHERE message_id = ? AND lease_token = ?`)
      .bind(info.mime_type,saved.byteSize,saved.sha256,new Date().toISOString(),id,token).run();
    if (result.meta.changes === 1) console.log(JSON.stringify({event:'media_ingest',state:'ready',type:row.message_type,
      voiceNote:row.is_voice_note === 1,bytes:saved.byteSize,hashVerified:true}));
  } catch (error) {
    controller.abort();
    const code = error instanceof MediaError ? error.code : 'transfer_failed';
    const retryable = error instanceof MediaError ? error.retryable : true;
    const owned = await env.DB.prepare('SELECT 1 AS owned FROM media_files WHERE message_id = ? AND lease_token = ?')
      .bind(id, token).first();
    if (!owned) return;
    if (uploadStarted && !await deleteObject(env,row.object_key)) {
      console.error(JSON.stringify({event:'media_cleanup_failed'}));
    }
    const state = retryable && row.attempts < 3 ? 'pending' : retryable ? 'failed' : 'rejected';
    await env.DB.prepare(`UPDATE media_files SET state = ?, error_code = ?, next_attempt_at = ?, lease_until = 0,
      lease_token = NULL, updated_at = ? WHERE message_id = ? AND lease_token = ?`)
      .bind(state,code,Date.now() + 5000,new Date().toISOString(),id,token).run();
    console.log(JSON.stringify({event:'media_ingest',state,errorCode:code,attempt:row.attempts,elapsedMs:Date.now()-time}));
  } finally { clearTimeout(timer); }
  await replyForMedia(env,id);
}

export async function runPendingMedia(env) {
  if (!mediaConfigured(env)) return;
  // Recover jobs interrupted on their last attempt, without retrying indefinitely.
  await env.DB.prepare(`UPDATE media_files SET state = 'failed', error_code = 'attempts_exhausted',
    lease_until = 0, lease_token = NULL WHERE state = 'processing' AND lease_until <= ? AND attempts >= 3 AND sender = ?`)
    .bind(Date.now(),env.ALLOWED_SENDER).run();
  const result = await env.DB.prepare(`SELECT m.message_id FROM media_files m JOIN inbound_messages i ON i.message_id = m.message_id
    WHERE m.sender = ? AND ((m.state = 'pending' AND m.next_attempt_at <= ?) OR
    (m.state = 'processing' AND m.lease_until <= ?) OR (m.state IN ('ready','failed','rejected') AND i.ack_state = 'pending'
      AND (m.state<>'ready' OR m.message_type<>'document' OR ?=0
        OR json_extract(i.payload_json,'$.call_artifact') IS NOT NULL OR ${documentStatusSql}<>'pending')))
    ORDER BY m.created_at LIMIT 3`).bind(env.ALLOWED_SENDER,Date.now(),Date.now(),env.AI&&env.FILES?1:0,env.FILE_DATASET || 'live').all();
  await Promise.all(result.results.map(row => processMedia(env,row.message_id).catch(() => {
    console.error(JSON.stringify({event:'media_job_failed'}));
  })));
}
