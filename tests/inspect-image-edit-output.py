#!/usr/bin/env python3
"""Independent pixels, image masks, original text and object-layer verification.
SPDX-License-Identifier: MIT OR Apache-2.0
"""
from pathlib import Path
import sys
import json
from PIL import Image, ImageChops, ImageStat
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = Path(sys.argv[1]).resolve()
    source = Image.open(output / 'source.png').convert('RGBA')
    edited = Image.open(output / 'cropped-erased.png').convert('RGBA')
    extracted = Image.open(output / 'extracted-original.png').convert('RGBA')
    final = Image.open(output / 'original-erased.png').convert('RGBA')
    assert source.size == edited.size == extracted.size == final.size == (160, 120)
    assert edited.getpixel((140, 100))[3] == 0, 'Concave excluded area must be transparent'
    assert edited.getpixel((20, 20))[3] == 0, 'Eraser removes alpha, not paints white'
    assert edited.getpixel((10, 100)) == source.getpixel((10, 100)), 'Retained pixels stay unchanged'
    assert edited.getpixel((140, 20)) == source.getpixel((140, 20))
    assert extracted.tobytes() == edited.tobytes(), 'Extracted PDF pixels retain their intrinsic orientation, filters and alpha'
    assert final.getpixel((19, 96))[3] == 0, 'Original PDF image eraser must affect real pixels'
    original_text = PdfReader(ROOT / 'fixtures/sample.pdf').pages[0].extract_text().rstrip('\r\n')
    for name, expected in [('edited-overlay.pdf', edited), ('edited-original.pdf', final)]:
        pdf = PdfReader(output / name)
        assert len(pdf.pages) == 1 and pdf.pages[0].extract_text().rstrip('\r\n') == original_text
        images = list(pdf.pages[0].images)
        assert len(images) == 1
        actual = images[0].image.convert('RGBA')
        assert actual.size == expected.size and actual.tobytes() == expected.tobytes()
    raster = PdfReader(output / 'explicit-raster-page.pdf')
    assert len(raster.pages) == 1 and not raster.pages[0].extract_text().strip()
    assert len(raster.pages[0].images) == 1, 'Explicit conversion is restricted to the requested page'
    multi = Image.open(output / 'multi-regions.png').convert('RGBA')
    assert multi.size == source.size
    assert multi.getpixel((10, 10)) == source.getpixel((10, 10))
    assert multi.getpixel((150, 110)) == source.getpixel((150, 110))
    assert multi.getpixel((80, 60))[3] == 0, 'Disjoint selection gaps remain transparent'
    multi_pdf = PdfReader(output / 'multi-regions.pdf')
    assert multi_pdf.pages[0].extract_text().rstrip('\r\n') == original_text
    assert list(multi_pdf.pages[0].images)[0].image.convert('RGBA').tobytes() == multi.tobytes()
    pdf_multi = Image.open(output / 'pdf-multi-regions.png').convert('RGBA')
    for x, y in [(.2, 1/7), (13/15, 23/28)]:
        assert pdf_multi.getpixel((int(x * pdf_multi.width), int(y * pdf_multi.height)))[3] == 255
    assert pdf_multi.getpixel((pdf_multi.width // 2, pdf_multi.height // 2))[3] == 0
    repair_source = Image.open(output / 'repair-source.png').convert('RGBA')
    repair = Image.open(output / 'repair-preview.png').convert('RGBA')
    mixed = Image.open(output / 'mixed-repair-result.png').convert('RGBA')
    mixed_preview = Image.open(output / 'mixed-repair-preview.png').convert('RGBA')
    assert repair_source.getpixel((26, 26)) == (0, 0, 0, 255)
    assert repair.getpixel((26, 26))[3] == 255, 'Background repair keeps alpha, unlike transparency erasure'
    assert max(abs(a-b) for a, b in zip(repair.getpixel((26, 26))[:3], (210, 35, 69))) < 6
    assert repair.getchannel('A').tobytes() == repair_source.getchannel('A').tobytes()
    assert mixed.tobytes() == mixed_preview.tobytes()
    assert mixed.getpixel((135, 98))[3] == 0 and mixed.getpixel((26, 26))[3] == 255
    assert mixed.getpixel((60, 60)) == repair_source.getpixel((60, 60)), 'Pixels outside both brush footprints stay unchanged'
    repair_pdf = PdfReader(output / 'mixed-repair.pdf')
    assert repair_pdf.pages[0].extract_text().rstrip('\r\n') == original_text
    assert list(repair_pdf.pages[0].images)[0].image.convert('RGBA').tobytes() == mixed.tobytes()
    result = json.loads((output / 'results.json').read_text(encoding='utf-8'))
    base = Image.open(output / 'object-lower.png').convert('RGBA')
    base = Image.alpha_composite(base, Image.open(output / 'object-moving.png').convert('RGBA'))
    base = Image.alpha_composite(base, Image.open(output / 'object-upper.png').convert('RGBA'))
    for index, mode in enumerate(result['foreground']):
        image = Image.open(output / f'object-foreground-{index}.png').convert('RGBA')
        if mode == 'multiply':
            mixed = ImageChops.multiply(base.convert('RGB'), image.convert('RGB')).convert('RGBA')
            base = Image.composite(mixed, base, image.getchannel('A'))
        else:
            base = Image.alpha_composite(base, image)
    complete = Image.open(output / 'object-complete.png').convert('RGBA')
    difference = ImageChops.difference(base.convert('RGB'), complete.convert('RGB'))
    extrema = max(value[1] for value in difference.getextrema())
    mean = max(ImageStat.Stat(difference).mean)
    assert extrema <= 3 and mean < .1, f'Object layers must reconstruct native appearance: {extrema}, {mean}'
    report = {'status': 'PASS', 'concaveCropAlpha': True, 'eraserAlpha': True, 'unaffectedPixelsUnchanged': True,
              'originalImageIntrinsicPixelsRetained': True, 'ordinaryEditsPreserveSearchableText': True,
              'pdfImagePixelsEqualEditedPng': True, 'explicitRasterHasOneImage': True,
              'disjointImageAndPdfRegions': True, 'backgroundRepairPreservesAlpha': True,
              'blackFeatureRemovedOnColoredBackground': True, 'mixedRepairAndTransparency': True,
              'repairPreviewEqualsAppliedPdfPixels': True,
              'objectLayers': {'maxColorDifference': extrema, 'meanDifference': mean}}
    (output / 'independent-results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
