"""Owner-gated fast ingestion; provider credentials stay in the Worker."""
import concurrent.futures
import hashlib
import hmac
import http.client
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time

import faiss
import numpy as np

from worker_endpoint import WORKER_HOST
CALLBACK = '/bridge/pdf-fast'
INDEX_DIR = Path('/var/lib/whats-pdf-index')
CACHE = Path('/tmp/pdf-batches')
ACTIVE = threading.BoundedSemaphore(1)
THREAD = threading.local()
INDEX_LOCK = threading.Lock()
CURRENT = None
CURRENT_KEY = None
TASKS = set()
TASK_LOCK = threading.Lock()


class CallbackFailure(Exception):
    def __init__(self, action, status, data):
        super().__init__('callback_http_' + str(status))
        self.status = status
        self.action = action
        self.detail = data if isinstance(data, dict) else {}


def publication_failure(error):
    # Only bounded transport/category fields; never forward request bodies or credentials.
    code = str(error) if re.fullmatch(r'[a-z_0-9]{1,80}', str(error)) else 'native_publication_exception'
    result = {'name': type(error).__name__[:64], 'code': code, 'message': code, 'retryable': publication_retryable(error)}
    if isinstance(error, CallbackFailure):
        result['httpStatus'] = error.status
        result['message'] = 'action=' + error.action + '; ' + code
        for key in ('error', 'stage', 'diagnosticKey'):
            value = error.detail.get(key)
            if isinstance(value, str) and re.fullmatch(r'[a-z_0-9]{1,80}', value):
                result['message'] += '; ' + key + '=' + value
    return result


def publication_retryable(error):
    if isinstance(error, CallbackFailure):
        if error.detail.get('error') in ('fast_plan', 'fast_vectors', 'fast_input', 'fast_auth', 'source_changed', 'rag_source_changed', 'fast_missing_chunks'):
            return False
        value = error.detail.get('retryable')
        if isinstance(value, bool):
            return value
        return error.status in (408, 429) or error.status >= 500
    return isinstance(error, (OSError, TimeoutError, http.client.HTTPException, json.JSONDecodeError)) or str(error) in ('fast_deadline', 'processing_deadline')


def publish_one(secret, args, position, values, deadline):
    for attempt in range(4):
        try:
            if time.monotonic() >= deadline:
                raise ValueError('fast_deadline')
            return callback(secret, args, 'publish', position=position, vectors=values[position:position + 16].tolist())
        except Exception as error:
            if not publication_retryable(error) or attempt == 3:
                raise
            delay = 2 ** attempt
            if time.monotonic() + delay >= deadline:
                raise
            time.sleep(delay)


def identity(args):
    if not re.fullmatch(r'[a-f0-9]{16}', args.get('fileId', '')) or any(not re.fullmatch(r'[a-f0-9]{64}', args.get(k, '')) for k in ('generation', 'sourceHash')):
        raise ValueError('invalid_identity')
    return {k: args[k] for k in ('fileId', 'generation', 'sourceHash')}


def name(args):
    return hashlib.sha256((args['fileId'] + ':' + args['generation'] + ':' + args['sourceHash']).encode()).hexdigest()


def callback(secret, args, action, **payload):
    body = json.dumps({**args, 'action': action, **payload}, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    if len(body) > 2 * 1024 * 1024:
        raise ValueError('callback_capacity')
    stamp = str(int(time.time()))
    digest = hashlib.sha256(body).hexdigest()
    signature = hmac.new(secret, ('whats-pdf-fast:v1:' + stamp + ':' + digest).encode(), hashlib.sha256).hexdigest()
    connection = getattr(THREAD, 'connection', None)
    if connection is None:
        connection = THREAD.connection = http.client.HTTPSConnection(WORKER_HOST, timeout=40)
    try:
        connection.request('POST', CALLBACK, body, {'Content-Type': 'application/json', 'X-Bridge-Time': stamp, 'X-Bridge-Signature': signature})
        response = connection.getresponse()
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('callback_output_capacity')
        if response.status != 200:
            try:
                error_data = json.loads(data)
            except (ValueError, UnicodeError):
                error_data = None
            raise CallbackFailure(action, response.status, error_data)
        value = json.loads(data)
        if value.get('success') is False or value.get('error'):
            raise ValueError('embedding_provider_rejected' if action == 'embed' else 'callback_rejected')
        return value.get('result', value)
    except Exception:
        connection.close()
        THREAD.connection = None
        raise


def matrix_path(args):
    return INDEX_DIR / (name(args) + '.npy')


def install_index(args, values):
    global CURRENT, CURRENT_KEY
    faiss.omp_set_num_threads(1)
    index = faiss.IndexFlatIP(1024)
    if len(values):
        normalized = values.copy()
        faiss.normalize_L2(normalized)
        index.add(normalized)
    with INDEX_LOCK:
        CURRENT, CURRENT_KEY = index, name(args)


def save_index(secret, args, values):
    INDEX_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    used = sum(p.stat().st_size for p in INDEX_DIR.glob('*.npy') if p != matrix_path(args))
    if used + values.nbytes > 256 * 1024 * 1024:
        raise ValueError('index_disk_capacity')
    target = matrix_path(args)
    temporary = target.with_suffix('.part')
    with temporary.open('wb') as output:
        np.save(output, values, allow_pickle=False)
        output.flush()
        os.fsync(output.fileno())
    digest = hashlib.sha256(temporary.read_bytes()).hexdigest()
    manifest = {**args, 'count': len(values), 'dimensions': 1024, 'matrixHash': digest}
    encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    signed = {'manifest': manifest, 'signature': hmac.new(secret, encoded, hashlib.sha256).hexdigest()}
    meta = target.with_suffix('.json')
    temp_meta = meta.with_suffix('.part.json')
    temp_meta.write_text(json.dumps(signed, separators=(',', ':')), encoding='utf-8')
    os.replace(temporary, target)
    os.replace(temp_meta, meta)
    return digest


def load_index(secret, args):
    target = matrix_path(args)
    if target.stat().st_size > 68 * 1024 * 1024:
        raise ValueError('index_capacity')
    signed = json.loads(target.with_suffix('.json').read_text(encoding='utf-8'))
    manifest = signed['manifest']
    encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    if not hmac.compare_digest(hmac.new(secret, encoded, hashlib.sha256).hexdigest(), signed['signature']) or any(manifest[k] != args[k] for k in args) or manifest['dimensions'] != 1024:
        raise ValueError('index_integrity')
    if hashlib.sha256(target.read_bytes()).hexdigest() != manifest['matrixHash']:
        raise ValueError('index_integrity')
    values = np.load(target, allow_pickle=False)
    if values.dtype != np.float32 or values.shape != (manifest['count'], 1024) or len(values) > 16384 or not np.isfinite(values).all():
        raise ValueError('index_integrity')
    install_index(args, values)
    return values, manifest['matrixHash']


def parallel(items, function, deadline, concurrency=8):
    def work(item):
        if time.monotonic() > deadline:
            raise ValueError('processing_deadline')
        return function(item)
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=concurrency)
    futures = [pool.submit(work, item) for item in items]
    try:
        for future in concurrent.futures.as_completed(futures):
            yield future.result()
    finally:
        for future in futures:
            future.cancel()
        pool.shutdown(wait=True, cancel_futures=True)


def run(secret, args):
    started = time.monotonic()
    output = CACHE / (name(args) + '.fast.json')
    try:
        if matrix_path(args).is_file() and matrix_path(args).with_suffix('.json').is_file():
            values, index_hash = load_index(secret, args)
            callback(secret, args, 'ready', readyMs=round((time.monotonic() - started) * 1000), extractMs=0, indexHash=index_hash)
        else:
            subprocess.run([sys.executable, str(Path(__file__).with_name('pdf_fast_extract.py')), str(CACHE / (args['sourceHash'] + '.pdf')), str(output)], check=True, timeout=75, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={'PATH': os.defpath, 'PYTHONIOENCODING': 'utf-8'})
            if output.stat().st_size > 96 * 1024 * 1024:
                raise ValueError('extraction_output_capacity')
            document = json.loads(output.read_text(encoding='utf-8'))
            output.unlink(missing_ok=True)
            pages, total = document['pages'], document['totalChunks']
            callback(secret, args, 'manifest', totalPages=len(pages), totalChunks=total)
            groups, group, size, first, position = [], [], 0, 0, 0
            for page in pages:
                length = len(page['text'].encode('utf-16-le')) // 2
                if group and (len(group) >= 16 or size + length > 120000):
                    groups.append((first, group))
                    group, size, first = [], 0, position
                group.append(page)
                size += length
                position += len(page['spans'])
            if group:
                groups.append((first, group))
            for _ in parallel(groups, lambda item: callback(secret, args, 'pages', chunkFirst=item[0], pages=item[1]), started + 120):
                pass
            values = np.empty((total, 1024), dtype='float32')

            def embedding(position):
                count = min(100, total - position)
                data = callback(secret, args, 'embed', position=position, count=count).get('data')
                array = np.asarray(data, dtype='float32')
                if array.shape != (count, 1024) or not np.isfinite(array).all():
                    raise ValueError('embedding_output')
                return position, array

            for position, array in parallel(range(0, total, 100), embedding, started + 120, concurrency=32):
                values[position:position + len(array)] = array
            index_hash = save_index(secret, args, values)
            install_index(args, values)
            ready_ms = round((time.monotonic() - started) * 1000)
            callback(secret, args, 'ready', readyMs=ready_ms, extractMs=document['extractMs'], indexHash=index_hash)
            print(json.dumps({'event': 'pdf_fast_native_ready', 'pages': len(pages), 'passages': total, 'readyMs': ready_ms, 'extractMs': document['extractMs']}), flush=True)
            del pages, groups, document
        # FAISS is already searchable. Vectorize publication is an asynchronous secondary copy.
        try:
            plan = callback(secret, args, 'publication_plan').get('positions')
            if not isinstance(plan, list) or len(plan) > (len(values) + 15) // 16 or len(set(plan)) != len(plan) or any(type(p) is not int or p < 0 or p >= len(values) or p % 16 for p in plan):
                raise ValueError('fast_plan')
            deadline = time.monotonic() + 120
            for _ in parallel(plan, lambda position: publish_one(secret, args, position, values, deadline), deadline, concurrency=2):
                pass
            callback(secret, args, 'publication_complete')
        except Exception as error:
            callback(secret, args, 'publication_failed', code='vectorize_publication_failed', failure=publication_failure(error))
    except Exception as error:
        code = str(error) if re.fullmatch(r'[a-z_0-9]{1,60}', str(error)) else 'fast_processing_failed'
        try:
            callback(secret, args, 'failed', code=code, retryable=publication_retryable(error))
        except Exception:
            pass
        print(json.dumps({'event': 'pdf_fast_native', 'state': 'failed', 'code': code}), flush=True)
    finally:
        output.unlink(missing_ok=True)
        with TASK_LOCK:
            TASKS.discard(name(args))
        ACTIVE.release()


def handle(handler, secret):
    """Called only after the existing PDF-tool HMAC and body-size validation."""
    size = int(handler.headers['Content-Length'])
    body = handler.rfile.read(size)
    if len(body) != size or hashlib.sha256(body).hexdigest() != handler.headers['X-Content-Sha256']:
        return handler.reply(400, {'error': 'integrity'})
    raw = json.loads(body)
    args = identity(raw)
    if handler.path == '/pdf-fast-search':
        vector = raw.get('vector')
        if not isinstance(vector, list) or len(vector) != 1024 or not all(type(v) in (int, float) and math.isfinite(v) for v in vector):
            return handler.reply(400, {'error': 'invalid_vector'})
        if CURRENT_KEY != name(args):
            load_index(secret, args)
        with INDEX_LOCK:
            if CURRENT_KEY != name(args):
                return handler.reply(503, {'error': 'index_changed'})
            query = np.asarray([vector], dtype='float32')
            faiss.normalize_L2(query)
            scores, positions = CURRENT.search(query, min(6, CURRENT.ntotal)) if CURRENT.ntotal else ([], [])
            matches = [{'position': int(p), 'score': float(s)} for p, s in zip(positions[0], scores[0]) if p >= 0] if CURRENT.ntotal else []
        return handler.reply(200, {'matches': matches})
    if handler.path != '/pdf-fast-start':
        return handler.reply(404, {'error': 'not_found'})
    if raw.get('publicationOnly') is True and not (matrix_path(args).is_file() and matrix_path(args).with_suffix('.json').is_file()):
        return handler.reply(503, {'error': 'publication_index_unavailable'})
    if not (CACHE / (args['sourceHash'] + '.pdf')).is_file() and not matrix_path(args).is_file():
        return handler.reply(410, {'error': 'source_missing'})
    with TASK_LOCK:
        if name(args) in TASKS:
            return handler.reply(200, {'started': True, 'existing': True})
        if not ACTIVE.acquire(blocking=False):
            return handler.reply(429, {'error': 'fast_task_busy'})
        TASKS.add(name(args))
    threading.Thread(target=run, args=(secret, args), daemon=True).start()
    return handler.reply(200, {'started': True})
