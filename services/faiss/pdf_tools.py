"""Signed page extraction and tokenizer utilities. No model inference or tool execution."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

WORK = threading.BoundedSemaphore(1)  # Independent of FAISS search lock.
CACHE = Path('/tmp/pdf-batches')
TOKENIZER = None
ROUTES = {'/pdf-upload', '/pdf-batch', '/token-count', '/pdf-fast-start', '/pdf-fast-search'}
MODEL = 'mistralai/Mistral-Small-3.1-24B-Instruct-2503'

def expire_sources():
    if not WORK.acquire(blocking=False):
        return
    try:
        for path in CACHE.glob('*.pdf'):
            if time.time() - path.stat().st_mtime > 86400:
                path.unlink(missing_ok=True)
    finally:
        WORK.release()

def tokenizer():
    global TOKENIZER
    if TOKENIZER is None:
        from mistral_common.tokens.tokenizers.mistral import MistralTokenizer
        TOKENIZER = MistralTokenizer.from_hf_hub(MODEL, revision='68faf511d618ef198fef186659617cfd2eb8e33a', local_files_only=True)
    return TOKENIZER

def count(messages):
    from mistral_common.protocol.instruct.request import ChatCompletionRequest
    request = ChatCompletionRequest.from_openai(messages=messages)
    return len(tokenizer().encode_chat_completion(request).tokens)

def handle(handler, secret):
    if not WORK.acquire(blocking=False):
        return handler.reply(429, {'error': 'busy'})
    try:
        handler.connection.settimeout(35)
        size = int(handler.headers.get('Content-Length', '0'))
        stamp = handler.headers.get('X-Bridge-Time', '')
        sig = handler.headers.get('X-Bridge-Signature', '')
        digest = handler.headers.get('X-Content-Sha256', '')
        limit = 50 * 1024 * 1024 if handler.path == '/pdf-upload' else 2 * 1024 * 1024
        if not 0 < size <= limit or not re.fullmatch(r'\d{10}', stamp) or abs(time.time() - int(stamp)) > 90 or not re.fullmatch(r'[a-f0-9]{64}', digest) or not re.fullmatch(r'[a-f0-9]{64}', sig):
            return handler.reply(403, {'error': 'forbidden'})
        expected = hmac.new(secret, f'whats-pdf-tools:v1:{handler.path}:{stamp}:{digest}:{size}'.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            return handler.reply(403, {'error': 'forbidden'})
        if handler.path in {'/pdf-fast-start', '/pdf-fast-search'}:
            from pdf_fast import handle as handle_fast
            return handle_fast(handler, secret)
        CACHE.mkdir(mode=0o700, exist_ok=True)
        for path in CACHE.glob('*.part'):
            path.unlink(missing_ok=True)  # No other PDF work can be active while this semaphore is held.
        # Temporary source bytes never survive more than24h of inactivity; cap cache at100MB.
        for path in CACHE.glob('*.pdf'):
            if time.time() - path.stat().st_mtime > 86400:
                path.unlink(missing_ok=True)
        if handler.path == '/pdf-upload':
            if sum(p.stat().st_size for p in CACHE.glob('*.pdf')) + size > 100 * 1024 * 1024 and not (CACHE / (digest + '.pdf')).exists():
                return handler.reply(429, {'error': 'cache_full'})
            path = CACHE / (digest + '.pdf')
            temp = CACHE / (digest + '.part')
            received, sha = 0, hashlib.sha256()
            try:
                already_present = path.is_file()
                with (open(os.devnull, 'wb') if already_present else temp.open('wb')) as target:
                    while received < size:
                        block = handler.rfile.read(min(65536, size - received))
                        if not block:
                            raise ValueError('short_body')
                        received += len(block)
                        sha.update(block)
                        target.write(block)
                if sha.hexdigest() != digest:
                    return handler.reply(400, {'error': 'integrity'})
                if not already_present:
                    temp.replace(path)
                os.utime(path, None)
            finally:
                temp.unlink(missing_ok=True)
            return handler.reply(200, {'sourceHash': digest, 'stored': True})
        body = handler.rfile.read(size)
        if len(body) != size or hashlib.sha256(body).hexdigest() != digest:
            return handler.reply(400, {'error': 'integrity'})
        args = json.loads(body)
        if handler.path == '/token-count':
            if set(args) != {'messages'} or not isinstance(args['messages'], list) or not 1 <= len(args['messages']) <= 8 or any(set(m) != {'role', 'content'} or m['role'] not in {'system', 'user', 'assistant'} or not isinstance(m['content'], str) for m in args['messages']):
                return handler.reply(400, {'error': 'invalid_request'})
            return handler.reply(200, {'tokens': count(args['messages']), 'tokenizer': MODEL})
        if set(args) != {'sourceHash', 'startPage'} or not re.fullmatch(r'[a-f0-9]{64}', args['sourceHash']) or type(args['startPage']) is not int or not 0 <= args['startPage'] < 2048:
            return handler.reply(400, {'error': 'invalid_request'})
        path = CACHE / (args['sourceHash'] + '.pdf')
        if not path.is_file():
            return handler.reply(410, {'error': 'source_missing'})
        os.utime(path, None)
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('pdf_batch.py')), str(path), str(args['startPage'])], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=11, env={'PATH': os.defpath, 'PYTHONIOENCODING': 'utf-8'}, check=True)
        if len(result.stdout) > 1048576:
            raise ValueError('output_limit')
        output = json.loads(result.stdout)
        for page in output['pages']:
            page['tokens'] = count([{'role': 'user', 'content': page['text']}])
        handler.reply(200, {'sourceHash': args['sourceHash'], **output})
    except (BrokenPipeError, ConnectionResetError):
        pass
    except Exception:
        handler.reply(503, {'error': 'pdf_tools_unavailable'})
    finally:
        WORK.release()
