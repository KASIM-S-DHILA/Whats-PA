import {ingestCalls,runPendingCalls} from './calls.js';
import {handleCallTool,recoverCallTools} from './call-tools.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { acknowledge } from './acknowledge.js';
import { isMediaMessage, mediaConfigured, createMediaStatement, processMedia, runPendingMedia } from './media.js';

import {indexingConfigured,runPendingIndex} from './indexing.js';
import {parseCommand,createCommandStatement,processCommand,runPendingCommands} from './commands.js';

const MAX_BODY_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function sameToken(actual, expected) {
  const left = createHash('sha256').update(actual ?? '').digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

async function readBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export default {
  async scheduled(controller, env) { await runPendingCommands(env); await recoverCallTools(env); await runPendingCalls(env); await runPendingMedia(env); await runPendingIndex(env); await runPendingCommands(env); },
  async fetch(request, env, ctx) {
    const started = performance.now();
    const url = new URL(request.url);
    if(url.pathname==='/bridge/tools'){
      if(request.method!=='POST')return new Response('Method not allowed',{status:405});
      const body=await readBody(request);if(body===null)return new Response('Payload too large',{status:413});
      try{return await handleCallTool(request,env,body);}catch{return Response.json({error:'tool_unavailable'},{status:503});}
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ phase: env.VOICE_CALL_TOOLS_ENABLED==='true'?7:5, mode: env.CALL_BRIDGE_ENABLED==='true'?'voice_notes_and_call_bridge':'voice_notes', status: 'ok' });
    }
    if (url.pathname !== '/webhook') return new Response('Not found', { status: 404 });

    if (request.method === 'GET') {
      if (!env.META_VERIFY_TOKEN) return new Response('Not configured', { status: 503 });
      const challenge = url.searchParams.get('hub.challenge');
      if (url.searchParams.get('hub.mode') !== 'subscribe' || challenge === null ||
          !sameToken(url.searchParams.get('hub.verify_token'), env.META_VERIFY_TOKEN)) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(challenge, { headers: { 'Content-Type': 'text/plain' } });
    }

    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!env.META_APP_SECRET) return new Response('Not configured', { status: 503 });
    const signature = request.headers.get('X-Hub-Signature-256');
    if (!/^sha256=[a-f0-9]{64}$/i.test(signature ?? '')) {
      return new Response('Forbidden', { status: 403 });
    }
    const body = await readBody(request);
    if (body === null) return new Response('Payload too large', { status: 413 });
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.META_APP_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.slice(7).match(/../g), hex => parseInt(hex, 16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, body)) {
      return new Response('Forbidden', { status: 403 });
    }
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(body)); }
    catch { return new Response('Invalid JSON', { status: 400 }); }
    if (payload?.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
      return new Response('Invalid webhook', { status: 400 });
    }
    if (!env.DB || !env.META_ACCESS_TOKEN || !/^\d{6,15}$/.test(env.ALLOWED_SENDER ?? '') ||
        !env.META_PHONE_NUMBER_ID || !env.META_WABA_ID || !ctx) {
      return new Response('Not configured', { status: 503 });
    }
    try{await ingestCalls(env,payload,ctx);}catch{console.error(JSON.stringify({event:'call_ingest_failed'}));return new Response('Call storage unavailable',{status:503});}
    const messages = [];
    let ignored = 0;
    for (const entry of payload.entry) {
      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (change?.field !== 'messages') continue;
        const value = change.value;
        for (const message of Array.isArray(value?.messages) ? value.messages : []) {
          if (entry.id !== env.META_WABA_ID || value.metadata?.phone_number_id !== env.META_PHONE_NUMBER_ID ||
              message?.from !== env.ALLOWED_SENDER || typeof message.id !== 'string' ||
              !message.id || message.id.length > 512 || typeof message.type !== 'string') {
            ignored++;
            continue;
          }
          messages.push(message);
        }
      }
    }
    if (messages.length > 100) return new Response('Too many messages', { status: 413 });
    if (messages.some(isMediaMessage) && !mediaConfigured(env)) return new Response('Media storage not configured', { status: 503 });
    let kicked = 0;
    let inserted = 0;
    let claimed = 0;
    try {
      for (const message of messages) {
        const now = new Date().toISOString();
        const media = isMediaMessage(message);
        let command = indexingConfigured(env) ? parseCommand(message,{natural:env.ASSISTANT_ENABLED==='true'}) : null;
        if(!command&&indexingConfigured(env)&&env.ASSISTANT_ENABLED==='true'&&message.type==='text'&&typeof message.text?.body==='string')command={kind:'assistant',args:{text:message.text.body,contextMessageId:typeof message.context?.id==='string'?message.context.id:null}};
        if(media&&indexingConfigured(env)&&env.ASSISTANT_ENABLED==='true'&&env.VOICE_NOTE_ASSISTANT_ENABLED==='true'&&message.type==='audio'&&message.audio?.voice===true)command={kind:'voice_assistant',args:{}};
        // Transaction + primary key serialize inserts and acknowledgment claims across replays.
        const results = await env.DB.batch([
          env.DB.prepare(`INSERT INTO inbound_messages
            (message_id, sender, phone_number_id, message_type, message_timestamp, payload_json, received_at, media_expected)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`)
            .bind(message.id, message.from, env.META_PHONE_NUMBER_ID, message.type,
              typeof message.timestamp === 'string' ? message.timestamp : null, JSON.stringify(message), now, media ? 1 : 0),
          media ? createMediaStatement(env, message, now) : command ? createCommandStatement(env,message,command,now) : env.DB.prepare(`UPDATE inbound_messages SET ack_state = 'sending', ack_updated_at = ?
            WHERE message_id = ? AND sender = ? AND ack_state = 'pending'`)
            .bind(now, message.id, env.ALLOWED_SENDER),
          ...(media&&command?[createCommandStatement(env,message,command,now)]:[])
        ]);
        if (results.some(result => !result.success)) throw new Error('D1 write failed');
        inserted += results[0].meta.changes;
        if (media) {
          if (kicked++ < 3) ctx.waitUntil(processMedia(env, message.id).then(async () => { await runPendingIndex(env); await runPendingCommands(env); }).catch(() => {
            console.error(JSON.stringify({ event: 'media_job_failed' }));
          }));
        } else if (command) {
          ctx.waitUntil(processCommand(env,message.id).catch(() => { console.error(JSON.stringify({event:'command_job_failed'})); }));
        } else if (results[1].meta.changes === 1) {
          claimed++;
          ctx.waitUntil(acknowledge(env, message.id));
        }
      }
    } catch {
      console.error(JSON.stringify({ event: 'phase1_ingest_failed' }));
      return new Response('Storage unavailable', { status: 503 });
    }
    console.log(JSON.stringify({
      event: 'phase5_webhook',
      signatureVerified: true,
      allowed: messages.length, inserted, duplicates: messages.length - inserted,
      ignored, acknowledgmentsClaimed: claimed,
      durationMs: Math.round((performance.now() - started) * 100) / 100
    }));
    return new Response('EVENT_RECEIVED');
  }
};
