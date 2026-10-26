"""Single-open text extraction in an isolated process. No OCR, models or network."""
import bisect
import json
import resource
import sys
import time

resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
import pymupdf


def spans(text):
    offsets = [0]
    for char in text:
        offsets.append(offsets[-1] + (2 if ord(char) > 0xffff else 1))
    result, start = [], 0
    while start < len(text):
        end = bisect.bisect_right(offsets, offsets[start] + 1500) - 1
        if end < len(text):
            cut = max(text.rfind('\n', start, end), text.rfind(' ', start, end))
            if cut > start + (end - start) // 2:
                end = cut + 1
        if end <= start:
            raise ValueError('page_boundary')
        if text[start:end].strip():
            result.append({'start': offsets[start], 'end': offsets[end]})
        start = end
    return result


def main():
    started = time.monotonic()
    with pymupdf.open(sys.argv[1]) as doc:
        if not doc.is_pdf or doc.needs_pass or not 1 <= doc.page_count <= 2048:
            raise ValueError('pdf_unavailable')
        pages, units, chunks = [], 0, 0
        for index in range(doc.page_count):
            raw = doc[index].get_text('text', sort=True)
            text = '\n\n## Page ' + str(index + 1) + '\n' + raw
            length = len(text.encode('utf-16-le')) // 2
            units += length
            if length > 60000 or units > 16000000:
                raise ValueError('pdf_text_capacity')
            slices = spans(text) if raw.strip() else []
            chunks += len(slices)
            if chunks > 16384:
                raise ValueError('pdf_chunk_capacity')
            pages.append({'page': index + 1, 'text': text, 'readable': bool(raw.strip()), 'spans': slices})
    with open(sys.argv[2], 'w', encoding='utf-8') as target:
        json.dump({'pages': pages, 'totalChunks': chunks, 'extractMs': round((time.monotonic() - started) * 1000)}, target, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
