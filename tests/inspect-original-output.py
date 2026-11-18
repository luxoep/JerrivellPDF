#!/usr/bin/env python3
"""Independent pypdf/Poppler/Pillow checks of original-worker.mjs outputs.

SPDX-License-Identifier: MIT OR Apache-2.0
Uses the inspection dependencies only; they are not app dependencies.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image
from pypdf import PdfReader
from pypdf.generic import ContentStream

root = Path(sys.argv[1]).resolve()
result = json.loads((root / 'result.json').read_text(encoding='utf-8-sig'))
passed = []
original = PdfReader(root / '原创 原文样本.pdf')
english = PdfReader(root / '原文英文替换.pdf')
assert len(english.pages) == 2
assert 'Original text revised.' in english.pages[0].extract_text()
assert 'Make room for clarity.' not in english.pages[0].extract_text()
assert 'Make room for clarity.' in english.pages[1].extract_text()
assert len(english.pages[0].images) == 0, 'Native text must not become a raster image'
original_ops = ContentStream(original.pages[0].get_contents(), original).operations
edited_ops = ContentStream(english.pages[0].get_contents(), english).operations
assert sum(op == b're' for _, op in edited_ops) == sum(op == b're' for _, op in original_ops)
assert 'PAGE-ONE' in english.pages[0].extract_text()
passed.append('English native text replaced, original independent copy retained, no text rasterization, vector rectangles retained')

cjk = PdfReader(root / '中文字体原文替换.pdf')
font_programs = set()
for page in cjk.pages:
    text = page.extract_text()
    assert '原文修改 DEMO' in text
    assert 'Make room for clarity.' not in text
    assert len(page.images) == 0
    for font_ref in page['/Resources']['/Font'].values():
        font = font_ref.get_object()
        for descendant in font.get('/DescendantFonts', []):
            descriptor = descendant.get_object().get('/FontDescriptor', {}).get_object()
            program_ref = descriptor.get('/FontFile2')
            if program_ref:
                font_programs.add(program_ref.idnum)
                assert len(program_ref.get_object().get_data()) > 1_000_000
assert len(font_programs) == 1, 'Two pages must share one actual embedded font program'
passed.append('CJK Unicode independently extractable with one shared embedded TrueType program across two pages')

removed = PdfReader(root / '移除原文对象.pdf')
assert 'Make room for clarity.' not in removed.pages[0].extract_text()
assert 'PAGE-ONE' in removed.pages[0].extract_text()
passed.append('Removed text absent from extracted page content, other text retained (not a secure-redaction guarantee)')

image_pdf = PdfReader(root / '替换单个原有图片.pdf')
colors = {image.image.convert('RGB').getpixel((16, 12)) for image in image_pdf.pages[0].images}
assert colors == {(255, 0, 0), (0, 255, 0)}, colors
passed.append('One original image replaced with green; second image remains red as an independent native image')

rotated = PdfReader(root / '旋转原文定位.pdf')
assert rotated.pages[0].rotation == 90
assert 'Exact bounds' in rotated.pages[0].extract_text()
passed.append('Rotation and changed text independently retained')

renders = []
for name in ['原文英文替换', '中文字体原文替换', '旋转原文定位', '替换单个原有图片']:
    prefix = root / (name + '-poppler')
    completed = subprocess.run(['pdftoppm', '-f', '1', '-singlefile', '-r', '96', '-png', str(root / (name + '.pdf')), str(prefix)], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr
    image_path = prefix.with_suffix('.png')
    with Image.open(image_path) as image:
        image.load()
        assert image.width > 500 and image.height > 500
        if name == '替换单个原有图片':
            for x, expected in [(.25, (0, 255, 0)), (.65, (255, 0, 0))]:
                actual = image.convert('RGB').getpixel((int(image.width * x), int(image.height * .805)))
                assert max(abs(a-b) for a, b in zip(actual, expected)) <= 1, (x, actual)
    renders.append({'file': image_path.name, 'stderr': completed.stderr.strip()})
assert hashlib.sha256((root / '原创 原文样本.pdf').read_bytes()).hexdigest() == result['originalHash']
passed.append('Independent Poppler rendering and color probes, immutable source SHA-256')
report = {'status': 'PASS', 'outputDirectory': str(root), 'passed': passed, 'renders': renders}
(root / 'independent.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
