#!/usr/bin/env python3
"""Inspect the documented 0.6 desktop workflow, independently of PDFium.

SPDX-License-Identifier: GPL-3.0-or-later
Requires pypdf; run after the manual desktop scenario in docs/验证记录.md.
"""
from pathlib import Path
import hashlib
import json
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results/0.6.0/desktop'


def main():
    path = OUT / 'desktop-workflow.pdf'
    reader = PdfReader(path)
    assert len(reader.pages) == 6
    texts = [page.extract_text() for page in reader.pages]
    assert 'Clarity,revised.' in ''.join(texts[0].split())
    assert 'Make room for clarity.' not in texts[0]
    assert all('INTERNAL' in text and f'{index + 1} / 6' in text for index, text in enumerate(texts))
    assert 'PAGE-TWO' in texts[4] and 'PAGE-THREE' in texts[5]
    assert reader.pages[5].rotation == 90
    for index in [1, 3]:
        assert len(texts[index].replace('INTERNAL', '').replace(f'{index + 1} / 6', '').strip()) == 0
    cropped = reader.pages[2]
    assert .79 < float(cropped.cropbox.width) / float(cropped.mediabox.width) < .82
    assert .83 < float(cropped.cropbox.height) / float(cropped.mediabox.height) < .86
    assert len(cropped.images) >= 1
    assert len(reader.pages[0].images) == 0, 'Edited title must remain native text'
    outputs = sorted((OUT / 'split').glob('sample_*.pdf'))
    assert len(outputs) == 2
    for file_index, output in enumerate(outputs):
        split = PdfReader(output)
        assert len(split.pages) == 3
        for index, page in enumerate(split.pages):
            assert page.extract_text() == texts[file_index * 3 + index]
    assert round(path.stat().st_size / 1048576, 2) == 23.72
    assert round(sum(output.stat().st_size for output in outputs) / 1048576, 2) == 35.56
    result = {'status': 'PASS', 'pages': 6, 'title': 'Clarity, revised.', 'nativeTitle': True,
              'allNumbersAndWatermarks': True, 'cropOnPage': 3, 'blankPages': [2, 4],
              'splitPageCounts': [3, 3], 'splitTextOrderMatchesFullDocument': True,
              'displayedSizeMatches': True, 'files': [
                  {'name': str(item.relative_to(OUT)), 'bytes': item.stat().st_size,
                   'sha256': hashlib.sha256(item.read_bytes()).hexdigest()} for item in [path, *outputs]]}
    (OUT / 'independent-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
