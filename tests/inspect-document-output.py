#!/usr/bin/env python3
"""Independent inspection of 0.6 page-tool output with pypdf (not PDFium).

SPDX-License-Identifier: MIT OR Apache-2.0
Run after tests/document-worker.mjs. Requires pypdf in a local Python runtime.
"""
from pathlib import Path
import hashlib
import json
import sys
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8-sig'))['version']
OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / f'test-results/{VERSION}/document-worker'


def native_objects(page):
    resources = page['/Resources']
    return resources.get('/XObject', {}).get_object() if '/XObject' in resources else {}


def main():
    checked = []
    original = PdfReader(OUTPUT / 'original.pdf')
    ordered = PdfReader(OUTPUT / 'ordered.pdf')
    assert len(ordered.pages) == 5
    for index, source in [(0, 2), (2, 0), (3, 0)]:
        assert ordered.pages[index].extract_text() == original.pages[source].extract_text()
    for index in [1, 4]:
        assert not ordered.pages[index].extract_text().strip()
    assert ordered.pages[3].rotation == 90
    checked.append('five-page blank/duplicate/order/rotation verified independently')
    reports = list(OUTPUT.glob('*.pdf.review.json'))
    for report_path in reports:
        report = json.loads(report_path.read_text(encoding='utf-8'))
        pdf_path = Path(str(report_path).removesuffix('.review.json'))
        assert pdf_path.stat().st_size == report['totalBytes']
        assert len(PdfReader(pdf_path).pages) == report['pageCount']
    checked.append(f'{len(reports)} preflight reports match actual file bytes and page counts')

    images = PdfReader(OUTPUT / 'images.pdf')
    assert len(images.pages) == 2
    for page in images.pages:
        assert any(obj.get_object().get('/Subtype') == '/Image' for obj in native_objects(page).values())
    checked.append('each converted image is a native PDF image XObject')

    crop = PdfReader(OUTPUT / 'crop-rotations.pdf')
    assert len(crop.pages) == 4
    for page in crop.pages:
        assert float(page.cropbox.width) < float(page.mediabox.width)
        assert float(page.cropbox.height) < float(page.mediabox.height)
        assert page.get_contents().get_data(), 'Crop must retain underlying content; it is not redaction'
    checked.append('four rotation variants use real CropBox and retain underlying content')

    decorated = PdfReader(OUTPUT / 'decorated.pdf').pages[0]
    assert '1 / 3' in decorated.extract_text()
    assert '内部资料' in decorated.extract_text()
    def embedded(page):
        for ref in page['/Resources']['/Font'].values():
            font = ref.get_object()
            for item in [font] + [value.get_object() for value in font.get('/DescendantFonts', [])]:
                descriptor = item.get('/FontDescriptor')
                if descriptor and any(key in descriptor.get_object() for key in ['/FontFile', '/FontFile2', '/FontFile3']):
                    return True
        return False
    assert embedded(decorated)
    checked.append('native numbering and Chinese watermark have extractable text and embedded font')
    chinese = PdfReader(OUTPUT / 'line-chinese.pdf').pages[0]
    assert '文字行修改预览' in chinese.extract_text()
    assert 'Make room for clarity.' not in chinese.extract_text()
    assert embedded(chinese)
    english = PdfReader(OUTPUT / 'line-edited.pdf').pages[0]
    assert 'Textlinerevised.' in ''.join(english.extract_text().split())
    assert b'TJ' in english.get_contents().get_data()
    checked.append('English TJ spacing and Chinese line edit are real text; old line removed')
    assert [len(PdfReader(OUTPUT / name).pages) for name in ['split-01.pdf', 'split-02.pdf']] == [1, 2]
    assert PdfReader(OUTPUT / 'split-01.pdf').pages[0].extract_text() == original.pages[2].extract_text()
    assert (OUTPUT / 'keep.pdf').read_bytes() == b'keep'
    assert not (OUTPUT / 'must-not-exist.pdf').exists()
    assert hashlib.sha256((OUTPUT / 'original.pdf').read_bytes()).hexdigest() == hashlib.sha256((ROOT / 'fixtures/sample.pdf').read_bytes()).hexdigest()
    checked.append('batch grouping/no-clobber and original PDF integrity')
    result = {'status': 'PASS', 'checks': len(checked), 'passed': checked}
    (OUTPUT / 'independent-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
