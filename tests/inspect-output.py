"""Independent pypdf / Pillow checks for the directory reported by worker-smoke.mjs.

These optional verification dependencies are not part of the desktop application.
"""
from pathlib import Path
import json
import math
import shutil
import subprocess
import sys
from pypdf import PdfReader
from PIL import Image, ImageChops


def image_objects(resources):
    """Resolve native image resources, including images nested in Form XObjects."""
    result = []
    visited = set()

    def visit(current):
        if current is None:
            return
        current = current.get_object()
        objects = current.get('/XObject', {})
        objects = objects.get_object() if hasattr(objects, 'get_object') else objects
        for reference in objects.values():
            obj = reference.get_object()
            key = id(obj)
            if key in visited:
                continue
            visited.add(key)
            if obj.get('/Subtype') == '/Image':
                result.append(obj)
            elif obj.get('/Subtype') == '/Form':
                visit(obj.get('/Resources'))

    visit(resources)
    return result


def blend_modes(resources):
    """Inspect actual PDF graphics states, including imported Form resources."""
    modes = set()
    visited = set()

    def visit(current):
        if current is None:
            return
        current = current.get_object()
        if id(current) in visited:
            return
        visited.add(id(current))
        states = current.get('/ExtGState', {})
        states = states.get_object() if hasattr(states, 'get_object') else states
        for state in states.values():
            mode = state.get_object().get('/BM')
            if mode is not None:
                modes.update(map(str, mode if isinstance(mode, list) else [mode]))
        objects = current.get('/XObject', {})
        objects = objects.get_object() if hasattr(objects, 'get_object') else objects
        for value in objects.values():
            obj = value.get_object()
            if obj.get('/Subtype') == '/Form':
                visit(obj.get('/Resources'))

    visit(resources)
    return modes


def render_first_page(pdftoppm, source, prefix):
    completed = subprocess.run(
        [pdftoppm, '-f', '1', '-l', '1', '-singlefile', '-scale-to-x', '600',
         '-scale-to-y', '-1', '-png', str(source), str(prefix)],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60,
    )
    assert completed.returncode == 0, completed.stderr
    with Image.open(prefix.with_suffix('.png')) as rendered:
        return rendered.convert('RGB')


def compare_overlay_with_poppler(directory, pdftoppm):
    original = render_first_page(
        pdftoppm, directory / '中文 合同 sample.pdf', directory / 'independent-original',
    )
    edited = render_first_page(
        pdftoppm, directory / '添加内容.pdf', directory / 'independent-overlay',
    )
    assert original.size == edited.size, (original.size, edited.size)
    assert original.width == 600
    difference = ImageChops.difference(original, edited)
    channels = difference.split()
    maximum = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
    # Ignore at most three levels of per-channel rounding noise, while retaining
    # material changes. A wrong coordinate transform should fail this bound.
    material = maximum.point(lambda value: 255 if value > 3 else 0)
    bounds = material.getbbox()
    assert bounds is not None, 'The overlay must visibly change the page'
    tolerance = 6
    expected = (
        math.floor(0.12 * original.width) - tolerance,
        math.floor(0.18 * original.height) - tolerance,
        math.ceil((0.12 + 0.28) * original.width) + tolerance,
        math.ceil((0.18 + 0.18) * original.height) + tolerance,
    )
    assert (bounds[0] >= expected[0] and bounds[1] >= expected[1]
            and bounds[2] <= expected[2] and bounds[3] <= expected[3]), (
        'Changed pixels must stay inside the intended normalized overlay rectangle',
        bounds, expected,
    )
    return {'renderedSize': list(original.size), 'changedPixelBounds': list(bounds),
            'allowedBounds': list(expected), 'perChannelNoiseTolerance': 3}

directory = Path(sys.argv[1])
merged = PdfReader(directory / '完整合并5页.pdf')
assert len(merged.pages) == 5
for page, marker in zip(merged.pages, ['PAGE-ONE', 'PAGE-TWO', 'PAGE-THREE', 'MERGE-ONE', 'MERGE-TWO']):
    assert marker in page.extract_text(), marker
assert [int(page.get('/Rotate', 0)) % 360 for page in merged.pages] == [0, 0, 90, 0, 0]
reordered = PdfReader(directory / '重排 合并结果.pdf')
assert len(reordered.pages) == 3
for page, marker in zip(reordered.pages, ['PAGE-THREE', 'MERGE-ONE', 'PAGE-ONE']):
    assert marker in page.extract_text(), marker
assert [int(page.get('/Rotate', 0)) % 360 for page in reordered.pages] == [180, 0, 0]
with Image.open(directory / '导出.png') as image:
    assert image.format == 'PNG'
    assert image.width == 1000
    image.verify()

overlaid = PdfReader(directory / '添加内容.pdf')
assert len(overlaid.pages) == 1
assert 'PAGE-ONE' in overlaid.pages[0].extract_text(), 'Original text must survive image overlays'
images = image_objects(overlaid.pages[0].get('/Resources'))
assert images, 'The added content must be represented by a PDF image XObject'
masked = [item for item in images if item.get('/SMask') is not None]
assert masked, 'Image transparency must be stored in a soft mask'
for item in masked:
    mask = item['/SMask'].get_object()
    assert mask.get('/Subtype') == '/Image'
    assert int(mask['/Width']) == int(item['/Width']) == 32
    assert int(mask['/Height']) == int(item['/Height']) == 32
    assert int(mask['/BitsPerComponent']) == 8
    mask_bytes = mask.get_data()
    assert len(mask_bytes) == 32 * 32
    assert min(mask_bytes) == 0 and 0 < max(mask_bytes) < 255, 'PNG alpha × overlay opacity must survive'

with Image.open(directory / '图章导出.png') as exported, Image.open(directory / '原创图形.png') as original:
    assert exported.format == 'PNG'
    assert exported.size == (32, 32)
    assert exported.mode == 'RGBA'
    assert exported.getchannel('A').getextrema() == (0, 255)
    assert exported.tobytes() == original.convert('RGBA').tobytes(), 'Export must retain original pixels and alpha'

checks = ['5-page merge and text order', '3-page reorder and native rotation', 'PNG structure',
          'overlay PDF keeps PAGE-ONE text, image XObject, and transparent soft mask',
          '32×32 RGBA stamp export retains source pixels and alpha']
fragment_path = directory / 'PDF片段正片叠底.pdf'
if fragment_path.exists():
    fragment_pdf = PdfReader(fragment_path)
    assert len(fragment_pdf.pages) == 1
    assert 'PAGE-ONE' in fragment_pdf.pages[0].extract_text()
    resources = fragment_pdf.pages[0].get('/Resources')
    assert '/Multiply' in blend_modes(resources), 'The saved PDF must use a real Multiply graphics state'
    fragments = image_objects(resources)
    assert fragments, 'The selected PDF region must appear as an image object'
    with Image.open(directory / 'PDF片段导出.png') as fragment_png:
        assert fragment_png.format == 'PNG' and fragment_png.mode == 'RGBA'
        assert any((int(item['/Width']), int(item['/Height'])) == fragment_png.size for item in fragments)
        assert abs(fragment_png.width / fragment_png.height - (0.9 * 612) / (0.35 * 792)) < 0.02
    checks.append('PDF fragment crop dimensions, retained destination text, and native /Multiply graphics state')
poppler = shutil.which('pdftoppm')
poppler_result = {'status': 'SKIPPED', 'reason': 'pdftoppm is not available on PATH'}
if poppler:
    poppler_result = {'status': 'PASS', **compare_overlay_with_poppler(directory, poppler)}
    checks.append('independent Poppler render changes only the intended overlay rectangle')
print(json.dumps({'status': 'PASS', 'independentEngine': 'pypdf + Pillow' + (' + Poppler' if poppler else ''),
                  'checks': checks, 'poppler': poppler_result,
                  'outputDirectory': str(directory)}, ensure_ascii=False, indent=2))
