#!/usr/bin/env python3
"""Inspect the documented 0.5.0 desktop marking + single/group sort scenario.

SPDX-License-Identifier: GPL-3.0-or-later
Verification-only pypdf/Pillow/Poppler dependencies; not application dependencies.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw
from pypdf import PdfReader
from pypdf.generic import ContentStream


root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]).resolve()
reader = PdfReader(output)
assert len(reader.pages) == 3
expected = ['PAGE-ONE', 'PAGE-THREE', 'PAGE-TWO']
for page, marker in zip(reader.pages, expected):
    assert marker in page.extract_text(), marker
assert [len(page.images) for page in reader.pages] == [0, 0, 5]
assert reader.pages[1].rotation == 90
page = reader.pages[2]
images = [item.image.convert('RGBA') for item in page.images]
assert images[0].getchannel('A').getextrema() == (89, 89), '35% highlight opacity must survive the actual PDF save'
assert images[1].getchannel('A').getextrema() == (255, 255), 'Solid block must remain fully opaque'
for image in images[2:]:
    assert image.getchannel('A').getextrema() == (0, 255), 'Outlines and strokes retain transparent backgrounds'
modes = {str(state.get_object().get('/BM')) for state in page['/Resources']['/ExtGState'].values()}
assert '/Multiply' in modes and '/Normal' in modes
assert 'Reading' in page.extract_text() and 'Search token: aurora' in page.extract_text()

stack, matrix, rectangles = [], [1, 0, 0, 1, 0, 0], []
for operands, operation in ContentStream(page.get_contents(), reader).operations:
    if operation == b'q':
        stack.append(matrix[:])
    elif operation == b'Q':
        matrix = stack.pop()
    elif operation == b'cm':
        a, b, c, d, e, f = matrix
        u, v, w, x, y, z = map(float, operands)
        matrix = [a*u+c*v, b*u+d*v, a*w+c*x, b*w+d*x, a*y+c*z+e, b*y+d*z+f]
    elif operation == b'Do':
        obj = page['/Resources']['/XObject'][operands[0]].get_object()
        if obj.get('/Subtype') == '/Image':
            a, b, c, d, e, f = matrix
            assert abs(b) < 1e-5 and abs(c) < 1e-5 and a > 0 and d > 0
            assert e >= 0 and f >= 0 and e + a <= float(page.mediabox.width) + .001 and f + d <= float(page.mediabox.height) + .001
            rectangles.append((e, f, e+a, f+d))
assert len(rectangles) == 5

poppler = shutil.which('pdftoppm')
assert poppler, 'Poppler is required for independent visual comparison'
prefix = output.with_suffix('')
warnings = []
for pdf, index, suffix in [(root / 'fixtures/sample.pdf', 2, '-baseline'), (output, 3, '-rendered')]:
    result = subprocess.run([poppler, '-f', str(index), '-l', str(index), '-singlefile', '-scale-to-x', '1000', '-scale-to-y', '-1', '-png', str(pdf), str(prefix) + suffix], capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert result.returncode == 0, result.stderr
    warnings.extend(result.stderr.strip().splitlines())
baseline = Image.open(str(prefix) + '-baseline.png').convert('RGB')
actual = Image.open(str(prefix) + '-rendered.png').convert('RGB')
assert baseline.size == actual.size
diff = ImageChops.difference(baseline, actual)
channels = diff.split()
changed = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2]).point(lambda value: 255 if value > 16 else 0)
mask = Image.new('L', actual.size)
draw = ImageDraw.Draw(mask)
sx, sy = actual.width / float(page.mediabox.width), actual.height / float(page.mediabox.height)
for left, bottom, right, top in rectangles:
    draw.rectangle((int(left*sx)-3, int(actual.height-top*sy)-3, int(right*sx)+3, int(actual.height-bottom*sy)+3), fill=255)
outside = ImageChops.multiply(changed, ImageChops.invert(mask))
assert outside.getbbox() is None, 'Pixels outside the five placed marks must remain unchanged'
changed_pixels = changed.histogram()[255]
assert changed_pixels > 5000
result = {
    'status': 'PASS', 'output': str(output), 'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
    'pageOrder': expected, 'imageObjectsPerPage': [0, 0, 5], 'nativeRotationRetained': 90,
    'highlightAlpha': 89, 'solidBlockAlpha': 255, 'blendModes': sorted(modes),
    'underlyingTextRetained': True, 'independentVisualEngine': 'Poppler',
    'renderedSize': actual.size, 'changedPixels': changed_pixels, 'changesOutsideMarkRectangles': 0,
    'popplerWarnings': sorted(set(warnings)),
}
print(json.dumps(result, ensure_ascii=False, indent=2))
