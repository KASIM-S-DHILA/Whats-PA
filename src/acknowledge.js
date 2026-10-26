// 'sent' means accepted by Meta, not delivered to the handset.
export async function sendResponse(env, messageId, content) {
  const {_chat,...outgoing}=content;
  let state = 'uncertain';
  let status = null;
  let replyId = null;
  try {
    const response = await fetch(`https://graph.facebook.com/v26.0/${env.META_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...outgoing, messaging_product: 'whatsapp', recipient_type: 'individual', to: env.ALLOWED_SENDER
      }),
      signal: AbortSignal.timeout(10000)
    });
    status = response.status;
    if (!response.ok) {
      state = 'failed';
      // Record only numeric Meta failure codes, never token, recipient or error text.
      let errorCode=null,errorSubcode=null;
      const reader=response.body?.getReader();
      if(reader){
        const parts=[];let size=0;
        try{
          for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16384){await reader.cancel();break;}parts.push(next.value);}
          if(size<=16384){const failure=JSON.parse(new TextDecoder().decode(Buffer.concat(parts))).error;
            if(Number.isSafeInteger(failure?.code))errorCode=failure.code;
            if(Number.isSafeInteger(failure?.error_subcode))errorSubcode=failure.error_subcode;}
        }catch{}finally{reader.releaseLock();}
      }
      console.warn(JSON.stringify({event:'phase1_ack_rejected',httpStatus:status,errorCode,errorSubcode}));
    } else {
      const data = await response.json();
      if (typeof data.messages?.[0]?.id === 'string' && data.messages[0].id) {
        state = 'sent';
        replyId = data.messages[0].id;
      }
    }
  } catch {
    // ponytail: no automatic resend after ambiguous API results; inspect D1 first.
    state = 'uncertain';
  }
  try {
    await env.DB.prepare(`UPDATE inbound_messages
      SET ack_state = ?, ack_message_id = ?, ack_http_status = ?, ack_updated_at = ?
      WHERE message_id = ? AND sender = ? AND ack_state = 'sending'`)
      .bind(state, replyId, status, new Date().toISOString(), messageId, env.ALLOWED_SENDER).run();
    console.log(JSON.stringify({ event: 'phase1_ack', state, httpStatus: status }));
  } catch {
    console.error(JSON.stringify({ event: 'phase1_ack_state_write_failed' }));
    state='uncertain';
  }
  return {state,replyId,httpStatus:status};
}

export function acknowledge(env,messageId,body='Received. Your message has been saved.'){
 return sendResponse(env,messageId,{type:'text',text:{body,preview_url:false}});
}
