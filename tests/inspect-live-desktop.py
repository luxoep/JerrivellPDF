#!/usr/bin/env python3
"""Independently inspect the documented 0.6.1 desktop marking scenario.
SPDX-License-Identifier: MIT OR Apache-2.0
Requires pypdf for verification only.
"""
from pathlib import Path
import hashlib
import json
from pypdf import PdfReader
from pypdf.generic import ContentStream

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results/0.6.1/desktop'


def main():
    path = OUT / 'mark-smooth.pdf'
    reader = PdfReader(path)
    source = PdfReader(ROOT / 'fixtures/sample.pdf')
    assert len(reader.pages) == 3
    for index in range(3):
        assert reader.pages[index].extract_text().rstrip('\r\n') == source.pages[index].extract_text().rstrip('\r\n')
    ops = ContentStream(reader.pages[0].get_contents(), reader).operations
    images = [args[0] for args, op in ops if op == b'Do']
    assert len(images) == 5
    resources = reader.pages[0]['/Resources']
    states = resources['/ExtGState'].get_object()
    assert any(item.get_object().get('/BM') == '/Multiply' for item in states.values())
    assert any(item.get_object().get('/BM') == '/Normal' for item in states.values())
    objects = resources['/XObject'].get_object()
    assert any('/SMask' in value.get_object() for value in objects.values()), 'Translucent marks must preserve alpha'
    result = {'status': 'PASS', 'pages': 3, 'placedImages': 5, 'textAndOrderUnchanged': True,
              'multiplyAndNormalRetained': True, 'alphaMaskRetained': True,
              'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    final = OUT / 'mark-hotkeys.pdf'
    assert final.is_file(), 'Complete the final slider undo/redo desktop scenario'
    final_reader = PdfReader(final)
    assert len(final_reader.pages) == 3
    for index in range(3):
        assert final_reader.pages[index].extract_text().rstrip('\r\n') == source.pages[index].extract_text().rstrip('\r\n')
    assert sum(op == b'Do' for _, op in ContentStream(final_reader.pages[0].get_contents(), final_reader).operations) == 6
    result['finalKeyboardScenario'] = {'placedImages': 6, 'textAndOrderUnchanged': True,
                                      'bytes': final.stat().st_size, 'sha256': hashlib.sha256(final.read_bytes()).hexdigest()}
    (OUT / 'independent-results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
