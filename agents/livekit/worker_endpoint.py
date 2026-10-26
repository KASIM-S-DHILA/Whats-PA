"""Explicit deployment origin; defaults to a non-routable example for source checkouts."""
import os
from urllib.parse import urlparse

WORKER_BASE_URL = os.environ.get('WORKER_BASE_URL', 'https://worker.example.invalid').rstrip('/')
_url = urlparse(WORKER_BASE_URL)
if (_url.scheme != 'https' or not _url.hostname or _url.username or _url.password
        or _url.port or _url.path not in ('', '/') or _url.query or _url.fragment):
    raise ValueError('invalid_worker_base_url')
WORKER_HOST = _url.hostname
