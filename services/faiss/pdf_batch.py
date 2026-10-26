"""Extract a bounded page batch from a verified local PDF; no OCR/network/secrets."""
import io
import json
import sys
import resource

resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
from pypdf import PdfReader

def main():
    path, start = sys.argv[1], int(sys.argv[2])
    reader = PdfReader(path, strict=True)
    total = len(reader.pages)
    if reader.is_encrypted or not 1 <= total <= 2048 or not 0 <= start < total:
        raise ValueError('pdf_unavailable')
    pages, chars = [], 0
    for index in range(start, min(start + 8, total)):
        raw = reader.pages[index].extract_text() or ''
        text = '\n\n## Page ' + str(index + 1) + '\n' + raw
        units = len(text.encode('utf-16-le')) // 2
        if units > 60000:
            raise ValueError('pdf_page_text_limit')
        if pages and chars + units > 60000:
            break
        pages.append({'page': index + 1, 'text': text, 'readable': bool(raw.strip())})
        chars += units
    print(json.dumps({'totalPages': total, 'nextPage': start + len(pages), 'pages': pages}, ensure_ascii=True, separators=(',', ':')))

if __name__ == '__main__':
    main()
