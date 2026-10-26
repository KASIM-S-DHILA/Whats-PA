"""Resource-limited text-layer extraction subprocess. No OCR, network, tools or secrets."""
import hashlib
import io
import json
import sys

try:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
except ImportError:
    pass

from pypdf import PdfReader


def main():
    data = sys.stdin.buffer.read(8388609)
    if not 0 < len(data) <= 8388608:
        raise ValueError('pdf_size')
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 64:
        raise ValueError('pdf_unavailable')
    text, page_map, warnings = '', [], ['pdf_text_layer_only', 'pdf_layout_not_verified']
    has_text = False
    units = lambda s: len(s.encode('utf-16-le')) // 2
    for number, page in enumerate(reader.pages, 1):
        raw = page.extract_text() or ''
        if not raw.strip():
            warnings.append('pdf_pages_without_text')
        else:
            has_text = True
        prefix = '\n\n## Page ' + str(number) + '\n'
        room = 60000 - units(text) - units(prefix)
        if room <= 0:
            warnings.append('pdf_character_limit')
            break
        cropped = raw.encode('utf-16-le')[:room * 2].decode('utf-16-le', errors='ignore')
        start = units(text)
        text += prefix + cropped
        page_map.append({'page': number, 'start': start, 'end': units(text)})
        if cropped != raw:
            warnings.append('pdf_character_limit')
            break
    if not has_text:
        text, page_map = '', []
    result = {'sourceHash': hashlib.sha256(data).hexdigest(), 'text': text, 'pageMap': page_map,
              'warnings': list(dict.fromkeys(warnings)), 'method': 'pdf_text:pypdf',
              'status': 'ready' if has_text else 'metadata_only',
              'reason': 'pdf_text_layer_only' if has_text else 'pdf_no_text_layer'}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
