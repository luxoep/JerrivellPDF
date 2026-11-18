#!/usr/bin/env python3
"""Independently inspect the real PDF fragment editor workflow outputs.
SPDX-License-Identifier: MIT OR Apache-2.0
Requires pypdf and Pillow for verification only.
"""
from pathlib import Path
import hashlib
import json
import sys
from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = Path(sys.argv[1]).resolve()
    png = Image.open(output / 'fragment-library.png').convert('RGBA')
    assert png.getchannel('A').getextrema() == (0, 255), 'White removal must create real transparency'
    assert len(png.getcolors(png.width * png.height)) > 20, 'The fragment must contain visible content'
    expected_text = PdfReader(ROOT / 'fixtures/sample.pdf').pages[0].extract_text().rstrip('\r\n')
    result = {'status': 'PASS', 'output': str(output), 'pngSize': list(png.size), 'documents': []}
    for name in ['placed-fragment.pdf', 'library-reopened.pdf']:
        path = output / name
        pdf = PdfReader(path)
        assert len(pdf.pages) == 1
        page = pdf.pages[0]
        assert page.extract_text().rstrip('\r\n') == expected_text
        assert sum(op == b'Do' for _, op in ContentStream(page.get_contents(), pdf).operations) == 1
        states = page['/Resources']['/ExtGState'].get_object()
        assert any(item.get_object().get('/BM') == '/Multiply' for item in states.values())
        images = list(page.images)
        assert len(images) == 1
        image = images[0].image.convert('RGBA')
        if name == 'library-reopened.pdf':
            assert image.size == png.size
            assert image.tobytes() == png.tobytes(), 'Library PNG pixels/alpha must survive export unchanged'
        result['documents'].append({'file': name, 'pages': 1, 'images': 1, 'multiply': True,
                                    'textUnchanged': True, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    source = output / '中文 来源 模板.pdf'
    assert source.read_bytes() == (ROOT / 'fixtures/second.pdf').read_bytes()
    result['sourceUnchanged'] = True
    (output / 'independent-results.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
