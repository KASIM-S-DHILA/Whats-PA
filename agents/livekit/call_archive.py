"""Send only caller transcripts for queued post-call relevance/summarization."""
import asyncio
import hashlib
import hmac
import io
import json
import logging
import time

import aiohttp
from worker_endpoint import WORKER_BASE_URL

log = logging.getLogger('whats.archive')
URL = WORKER_BASE_URL + '/bridge/artifacts'


def transcript_bytes(report):
    turns = []
    for item in report.chat_history.items:
        if item.type != 'message' or item.role != 'user':
            continue
        text = '\n'.join(part for part in item.content if isinstance(part, str)).strip()
        if text:
            turns.append(text)
    if not turns:
        return None
    if len(turns) > 80 or sum(len(text) for text in turns) > 60000:
        raise ValueError('transcript_limit')
    data = json.dumps({'version': 2, 'callerTurns': turns}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    if len(data) > 262144:
        raise ValueError('transcript_limit')
    return data


async def archive_session(report, call_id, secret):
    data = transcript_bytes(report)
    if data is None:
        return
    digest, size = hashlib.sha256(data).hexdigest(), len(data)
    async with aiohttp.ClientSession() as http:
        for attempt in range(2):
            stamp = str(int(time.time()))
            signature = hmac.new(secret.encode(), f'whats-archive:v1:{stamp}:{call_id}:transcript:{digest}:{size}'.encode(), hashlib.sha256).hexdigest()
            headers = {'X-Bridge-Time': stamp, 'X-Bridge-Signature': signature, 'X-Call-Id': call_id,
                       'X-Archive-Kind': 'transcript', 'X-Content-Sha256': digest, 'X-Content-Bytes': str(size),
                       'Content-Type': 'application/json', 'Content-Length': str(size)}
            try:
                with io.BytesIO(data) as body:
                    async with http.post(URL, data=body, headers=headers, allow_redirects=False,
                                         timeout=aiohttp.ClientTimeout(total=12)) as response:
                        raw = await response.content.read(4097)
                        result = json.loads(raw) if len(raw) <= 4096 else {}
                        if response.status == 200 and result.get('confirmed') is True and result.get('state') == 'queued':
                            log.info(json.dumps({'event': 'call_summary_transcript', 'state': 'queued', 'bytes': size}))
                            return
                        retry = response.status in (409, 429) or response.status >= 500
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                retry = True
            if not retry or attempt:
                break
            await asyncio.sleep(0.25)
    log.warning(json.dumps({'event': 'call_summary_transcript', 'state': 'unconfirmed'}))
