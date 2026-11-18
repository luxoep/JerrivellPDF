"""Independent checks for opt-in Microsoft Print to PDF verification outputs."""
# SPDX-License-Identifier: MIT OR Apache-2.0
from pathlib import Path
import json
import shutil
import subprocess
import sys
from pypdf import PdfReader
from PIL import Image, ImageChops, ImageStat


def render(source, page, prefix):
    command = [shutil.which('pdftoppm'), '-f', str(page + 1), '-l', str(page + 1),
               '-singlefile', '-r', '72', '-png', str(source), str(prefix)]
    completed = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60)
    assert completed.returncode == 0, completed.stderr
    with Image.open(prefix.with_suffix('.png')) as image:
        return image.convert('RGB')


def colored_bounds(image):
    # Source pages have a saturated background covering the full page; printer
    # paper is white. Interior black/white marks do not affect outer bounds.
    red, green, blue = image.split()
    maximum = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    minimum = ImageChops.darker(ImageChops.darker(red, green), blue)
    spread = ImageChops.subtract(maximum, minimum)
    saturation = spread.point(lambda value: 255 if value > 45 else 0)
    return saturation.getbbox()


def compare_colors(original, printed):
    first_bounds, second_bounds = colored_bounds(original), colored_bounds(printed)
    assert first_bounds and second_bounds
    first, second = original.crop(first_bounds), printed.crop(second_bounds)
    second = second.resize(first.size, Image.Resampling.BILINEAR)
    differences = []
    # Ignore source samples on a hard shape boundary. Homogeneous color patches
    # detect page order, intrinsic rotation, RGB/BGR reversal and Multiply loss.
    for x in [0.15, 0.25, 0.4, 0.5, 0.65, 0.75, 0.85]:
        for y in [0.15, 0.25, 0.4, 0.5, 0.65, 0.75, 0.85]:
            px, py = round(x * (first.width - 1)), round(y * (first.height - 1))
            box = (max(0, px - 1), max(0, py - 1), min(first.width, px + 2), min(first.height, py + 2))
            left = ImageStat.Stat(first.crop(box))
            if max(left.stddev) > 10:
                continue
            right = ImageStat.Stat(second.crop(box))
            differences.append(max(abs(a - b) for a, b in zip(left.mean, right.mean)))
    assert len(differences) >= 20
    assert max(differences) <= 22, ('Color/orientation mismatch', max(differences), first_bounds, second_bounds)
    return {'sampleCount': len(differences), 'maximumChannelMeanDifference': round(max(differences), 3)}


summary = Path(sys.argv[1])
data = json.loads(summary.read_text(encoding='utf-8-sig'))
assert data['status'] == 'PASS'
directory = Path(data['outputDirectory'])
assert shutil.which('pdftoppm'), 'Independent Poppler rendering is required'
source = PdfReader(data['source'])
assert len(source.pages) == 3
reference = [render(Path(data['source']), i, directory / f'independent-reference-{i}') for i in range(3)]
multiply_reference = render(Path(data['multiplied']), 0, directory / 'independent-reference-multiply')
states = PdfReader(data['multiplied']).pages[0]['/Resources']['/ExtGState']
assert any(state.get_object().get('/BM') == '/Multiply' for state in states.values())
if data.get('mode') == 'headless-raster':
    assert data['createdSpoolJob'] is False
    cases = []
    for output in data['outputs']:
        pages = []
        for index, item in enumerate(output['pages']):
            with Image.open(Path(output['directory']) / item['file']) as image:
                rendered = image.convert('RGB')
            expected_image = multiply_reference if output['name'] == 'multiply' and index == 0 else reference[index]
            expected_width = int(item['pageWidthPoints'] / 72 * 300)
            expected_height = int(item['pageHeightPoints'] / 72 * 300)
            assert not item['reducedByBudget']
            assert rendered.size == (expected_width, expected_height), (rendered.size, expected_width, expected_height)
            if output['name']=='grayscale':
                r,g,b=rendered.split();assert ImageChops.difference(r,g).getbbox() is None and ImageChops.difference(g,b).getbbox() is None
                expected_gray=expected_image.convert('L').resize(rendered.size,Image.Resampling.BILINEAR)
                mean_error=ImageStat.Stat(ImageChops.difference(r,expected_gray)).mean[0]
                assert mean_error<4,mean_error
                pages.append({'page':index+1,'sizeAt300dpi':list(rendered.size),'rgbChannelsEqual':True,'grayReferenceMeanError':mean_error})
            else:
                pages.append({'page': index + 1, 'sizeAt300dpi': list(rendered.size), **compare_colors(expected_image, rendered)})
        cases.append({'name': output['name'], 'pages': pages})
    result = {'status': 'PASS', 'mode': 'headless-raster', 'createdSpoolJob': False,
              'independentEngine': 'pypdf + Pillow + Poppler', 'cases': cases,
              'checks': ['production BGRA printing buffer and RGB channel order', '300dpi source dimensions',
                         'original page order and intrinsic rotation', 'Multiply fragment color appearance'],
              'scope': 'No printer dialog, GDI submission or physical output was validated by this headless check.'}
    (directory / 'independent-raster.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    summary.with_name('independent-raster.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0)
assert data['printer'] == 'Microsoft Print to PDF'
records = []
for output in data['outputs']:
    file = Path(output['output'])
    reader = PdfReader(file)
    expected_count = 3 * output['options']['copies']
    assert len(reader.pages) == expected_count, (output['name'], len(reader.pages), expected_count)
    pages = []
    for index, page in enumerate(reader.pages):
        source_index = index % 3
        rendered = render(file, index, directory / f"independent-{output['name']}-{index}")
        bounds = colored_bounds(rendered)
        assert bounds is not None
        width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
        expected_image = multiply_reference if output['name'].startswith('multiply-') and source_index == 0 else reference[source_index]
        colors = compare_colors(expected_image, rendered)
        paper_width = float(page.mediabox.width)
        paper_height = float(page.mediabox.height)
        if output['options']['orientation'] == 'auto':
            assert (paper_width > paper_height) == (source_index != 0), (output['name'], index, paper_width, paper_height)
        else:
            assert paper_height > paper_width
        expected_dimensions = [(72, 144), (216, 72), (144, 72)][source_index]
        if output['options']['scale'] == 'actual':
            assert abs(width - expected_dimensions[0]) <= 2
            assert abs(height - expected_dimensions[1]) <= 2
            assert abs((bounds[0] + bounds[2]) / 2 - rendered.width / 2) <= 2
            assert abs((bounds[1] + bounds[3]) / 2 - rendered.height / 2) <= 2
        else:
            assert abs(width / height - expected_dimensions[0] / expected_dimensions[1]) <= 0.025
        pages.append({'sourcePage': source_index + 1, 'paperPoints': [round(paper_width, 3), round(paper_height, 3)],
                      'coloredContentPixelsAt72dpi': [width, height], 'bounds': list(bounds), **colors})
    records.append({'name': output['name'], 'pageCount': len(reader.pages), 'pages': pages})
result = {'status': 'PASS', 'independentEngine': 'pypdf + Pillow + Poppler',
          'checks': ['fit/actual printable content', 'auto portrait/landscape including intrinsic rotation',
                     'two collated copies and colored page order', 'actual physical size and centering within 2 points',
                     'RGB colors and Multiply fragment appearance retained'],
          'cases': records, 'scope': 'Original synthetic color targets on Microsoft Print to PDF; no physical output or general font fidelity claim.'}
(directory / 'independent-printing.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
summary.with_name('independent-printing.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(result, ensure_ascii=False, indent=2))
