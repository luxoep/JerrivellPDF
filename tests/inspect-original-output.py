#!/usr/bin/env python3
"""Independent pypdf/Poppler/Pillow checks of original-worker.mjs outputs.

SPDX-License-Identifier: MIT OR Apache-2.0
Uses the inspection dependencies only; they are not app dependencies.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import struct
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

def installed_programs(page):
    for font_ref in page['/Resources']['/Font'].values():
        font = font_ref.get_object()
        for descendant in font.get('/DescendantFonts', []):
            descriptor = descendant.get_object()['/FontDescriptor'].get_object()
            program = descriptor.get('/FontFile2')
            if program:
                yield program.get_object().get_data()


def program_style(data):
    assert data[:4] == b'\0\1\0\0', 'Expected a real embedded TrueType program'
    table_count = struct.unpack_from('>H', data, 4)[0]
    for index in range(table_count):
        tag, _, offset, length = struct.unpack_from('>4sIII', data, 12 + index * 16)
        if tag == b'OS/2':
            assert length >= 64 and offset + length <= len(data)
            weight = struct.unpack_from('>H', data, offset + 4)[0]
            selection = struct.unpack_from('>H', data, offset + 62)[0]
            return weight >= 600 or bool(selection & 0x20), bool(selection & 1)
    raise AssertionError('Embedded TrueType font has no OS/2 style table')


# PDFium's TrueType ToUnicode may choose U+00A0 for the shared space glyph.
# Permit exactly that whitespace alias, not arbitrary missing/replaced letters.
whitespace_aliases = {}
def style_text(page, name):
    value = page.extract_text()
    whitespace_aliases[name] = value.count('\u00a0')
    return value.replace('\u00a0', ' ')

program_digests = set()
for index, expected_style in enumerate([(False, False), (True, False), (False, True), (True, True)]):
    styled = PdfReader(root / f'native-style-{index}.pdf')
    page = styled.pages[0]
    assert 'Native styled text' in style_text(page, f'native-style-{index}.pdf')
    assert 'Make room for clarity.' not in page.extract_text()
    assert len(page.images) == 0, 'Styled native text must remain text'
    programs = list(installed_programs(page))
    assert len(programs) == 1
    assert program_style(programs[0]) == expected_style
    program_digests.add(hashlib.sha256(programs[0]).hexdigest())
    states = page['/Resources']['/ExtGState'].values()
    assert any(abs(float(state.get_object().get('/ca', 1)) - .65) < .005 for state in states)
assert len(program_digests) == 4, 'Four styles must use distinct actual installed font programs'
passed.append('Four independently inspected TrueType OS/2 real styles, actual alpha ExtGState, searchable Unicode and zero text images')

line_pdf = PdfReader(root / 'native-line-style.pdf')
line_page = line_pdf.pages[0]
assert 'Styled line preview' in style_text(line_page, 'native-line-style.pdf')
assert 'Make room for clarity.' not in line_page.extract_text()
assert len(line_page.images) == 0
assert any(program_style(data) == (True, True) for data in installed_programs(line_page))
line_ops = ContentStream(line_page.get_contents(), line_pdf).operations
assert sum(op == b'S' for _, op in line_ops) >= sum(op == b'S' for _, op in original_ops) + 2, 'Decoration strokes must be vector paths'
assert any(op == b'TJ' and any(isinstance(item, (int, float)) and item != 0 for item in operands[0]) for operands, op in line_ops), 'Native character spacing must survive in text-show advances'
assert any(abs(float(state.get_object().get('/ca', 1)) - .6) < .005 for state in line_page['/Resources']['/ExtGState'].values())
passed.append('Styled line remains native Unicode text, distinct vector decoration strokes, native TJ spacing, transparent fill and real bold-italic font')

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
for name in ['原文英文替换', '中文字体原文替换', '旋转原文定位', '替换单个原有图片', 'native-style-3', 'native-line-style']:
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
report = {'status': 'PASS', 'outputDirectory': str(root), 'passed': passed, 'renders': renders, 'unicodeWhitespaceAliases': whitespace_aliases, 'whitespaceNote': 'U+00A0 is normalized to U+0020 only for these text assertions. Exact Unicode whitespace identity is not claimed.'}
(root / 'independent.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
