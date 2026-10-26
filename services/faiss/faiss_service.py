"""Authenticated, read-only FAISS retrieval. No document text, pickle, or index-file deserialization."""
import hashlib
import hmac
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import faiss
import numpy as np
from worker_endpoint import WORKER_BASE_URL
from pdf_tools import ROUTES, handle as handle_pdf_tools, expire_sources

WORKER = WORKER_BASE_URL + '/bridge/rag-index'
SECRET = os.environ['RAG_INDEX_SECRET'].encode()
LOCK = threading.Lock()
INDEX = None
IDS = []
REVISION = None
CHECKED = 0.0


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def snapshot_request(payload):
    body = json.dumps(payload, separators=(',', ':')).encode()
    stamp = str(int(time.time()))
    sig = hmac.new(SECRET, b'whats-rag-index:v1:' + stamp.encode() + b':' + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(WORKER, data=body, headers={'Content-Type': 'application/json', 'X-Bridge-Time': stamp, 'X-Bridge-Signature': sig}, method='POST')
    with urllib.request.build_opener(NoRedirect).open(request, timeout=8) as response:
        data = response.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('snapshot_limit')
        return json.loads(data)


def refresh():
    global INDEX, IDS, REVISION, CHECKED
    now = time.monotonic()
    if INDEX is not None and now - CHECKED < 30:
        return
    current = snapshot_request({'action': 'version'})
    if current['dimensions'] != 1024:
        raise ValueError('dimensions')
    if INDEX is not None and current['revision'] == REVISION:
        CHECKED = now
        return
    ids, vectors, after = [], [], None
    for _ in range(16):
        page = snapshot_request({'action': 'snapshot', **({'after': after} if after else {})})
        if page['revision'] != current['revision'] or page['dimensions'] != 1024:
            raise ValueError('snapshot_changed')
        for row in page['rows']:
            if not re.fullmatch(r'[a-f0-9]{64}', row['id']) or len(row['vector']) != 1024 or not all(type(v) in (int, float) and math.isfinite(v) for v in row['vector']):
                raise ValueError('snapshot_invalid')
            ids.append(row['id'])
            vectors.append(row['vector'])
        after = page['next']
        if after is None:
            break
    if after is not None or len(set(ids)) != len(ids):
        raise ValueError('snapshot_capacity')
    if snapshot_request({'action': 'version'})['revision'] != current['revision']:
        raise ValueError('snapshot_changed')
    index = faiss.IndexFlatIP(1024)
    if vectors:
        values = np.asarray(vectors, dtype='float32')
        faiss.normalize_L2(values)
        index.add(values)
    INDEX, IDS, REVISION, CHECKED = index, ids, current['revision'], now


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass  # Never log vectors, signatures, identifiers or request data.

    def reply(self, code, value):
        body = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200 if self.path == '/health' else 404, {'service': 'faiss', 'ready': self.path == '/health'})

    def do_POST(self):
        if self.path in ROUTES:
            return handle_pdf_tools(self, SECRET)
        if self.path == '/extract-pdf':
            return self.extract_pdf()
        if self.path != '/search':
            return self.reply(404, {'error': 'not_found'})
        try:
            self.connection.settimeout(5)
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 50000:
                return self.reply(413, {'error': 'size_limit'})
            body = self.rfile.read(size)
            stamp, sig = self.headers.get('X-Bridge-Time', ''), self.headers.get('X-Bridge-Signature', '')
            expected = hmac.new(SECRET, b'whats-faiss:v1:' + stamp.encode() + b':' + body, hashlib.sha256).hexdigest()
            if not re.fullmatch(r'\d{10}', stamp) or abs(time.time() - int(stamp)) > 60 or not re.fullmatch(r'[a-f0-9]{64}', sig) or not hmac.compare_digest(sig, expected):
                return self.reply(403, {'error': 'forbidden'})
            args = json.loads(body)
            vector, limit = args['vector'], args['limit']
            if set(args) != {'vector', 'limit'} or len(vector) != 1024 or type(limit) is not int or not 1 <= limit <= 30 or not all(type(v) in (int, float) and math.isfinite(v) for v in vector):
                return self.reply(400, {'error': 'invalid_query'})
            with LOCK:
                refresh()
                query = np.asarray([vector], dtype='float32')
                faiss.normalize_L2(query)
                _, positions = INDEX.search(query, min(limit, len(IDS))) if IDS else (None, [[]])
                ids = [IDS[int(i)] for i in positions[0] if i >= 0]
            self.reply(200, {'ids': ids})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.reply(503, {'error': 'retrieval_unavailable'})

    def extract_pdf(self):
        try:
            self.connection.settimeout(10)
            size = int(self.headers.get('Content-Length', '0'))
            stamp = self.headers.get('X-Bridge-Time', '')
            sig = self.headers.get('X-Bridge-Signature', '')
            digest = self.headers.get('X-Content-Sha256', '')
            if not 0 < size <= 8388608 or not re.fullmatch(r'\d{10}', stamp) or abs(time.time() - int(stamp)) > 60 or not re.fullmatch(r'[a-f0-9]{64}', digest):
                return self.reply(403, {'error': 'forbidden'})
            expected = hmac.new(SECRET, f'whats-rag-pdf:v1:{stamp}:{digest}:{size}'.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                return self.reply(403, {'error': 'forbidden'})
            data = self.rfile.read(size)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                return self.reply(400, {'error': 'integrity'})
            with LOCK:
                result = subprocess.run([sys.executable, str(Path(__file__).with_name('pdf_extract.py'))], input=data,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=12,
                                        env={'PATH': os.defpath, 'PYTHONIOENCODING': 'utf-8'}, check=True)
            if len(result.stdout) > 1048576:
                raise ValueError('output_limit')
            self.reply(200, json.loads(result.stdout))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.reply(503, {'error': 'pdf_unavailable'})


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def service_actions(self):
        expire_sources()
        global INDEX, IDS, REVISION, CHECKED
        if INDEX is not None and time.monotonic() - CHECKED > 300 and LOCK.acquire(blocking=False):
            try:
                INDEX, IDS, REVISION, CHECKED = None, [], None, 0.0
            finally:
                LOCK.release()


if __name__ == '__main__':
    faiss.omp_set_num_threads(1)
    Server(('0.0.0.0', int(os.environ.get('PORT', '7860'))), Handler).serve_forever()
