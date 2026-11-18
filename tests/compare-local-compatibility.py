# SPDX-License-Identifier: MIT OR Apache-2.0
"""Opt-in, local-only compatibility test. Never serializes drawing text/images.

Pass one authorized local PDF plus the exact exe, DLL and output JSON paths.
The only derivative is an owned temporary PDF beside the report; it is removed.
No private PDF, path, digest, rendered image or derivative enters the source ZIP.
"""
from pathlib import Path
import argparse, hashlib, json, os, queue, subprocess, tempfile, threading, time, uuid
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, NameObject


class Worker:
    def __init__(self, exe, dll, flag):
        self.process = subprocess.Popen([str(exe), flag, '--pdfium-path', str(dll)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.replies, self.states, self.sequence = queue.Queue(), {}, 0
        def read():
            try:
                for line in self.process.stdout:
                    reply = json.loads(line)
                    if reply.get('progress'):
                        self.states[reply['progress']['jobId']] = reply['progress']
                    elif reply.get('id'):
                        self.replies.put(reply)
            finally:
                self.replies.put({'error': 'native worker stopped'})
        threading.Thread(target=read, daemon=True).start()

    def call(self, command, args=None):
        self.sequence += 1
        self.process.stdin.write((json.dumps({'id': self.sequence, 'command': command, 'args': args or {}}) + '\n').encode())
        self.process.stdin.flush()
        reply = self.replies.get(timeout=120)
        assert reply.get('id') == self.sequence and not reply.get('error'), 'Native request failed; private details withheld'
        return reply.get('result')

    def compare(self, options):
        job = str(uuid.uuid4())
        self.call('start', {'jobId': job, 'options': options})
        end = time.monotonic() + 120
        while time.monotonic() < end:
            state = self.states.get(job)
            if state and state['status'] != 'running':
                assert state['status'] == 'complete', 'Native comparison did not finish'
                return state['report']
            time.sleep(.02)
        raise AssertionError('Native comparison exceeded the test deadline')

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)


def run(source, exe, dll, output):
    before = hashlib.sha256(source.read_bytes()).digest()
    compare, main, derivative = None, None, None
    result = {'method': 'Local native worker; no screenshots, text extraction or network calls',
              'executableSha256': hashlib.sha256(exe.read_bytes()).hexdigest(),
              'pdfiumSha256': hashlib.sha256(dll.read_bytes()).hexdigest()}
    try:
        compare, main = Worker(exe, dll, '--compare-worker'), Worker(exe, dll, '--pdf-worker')
        a = compare.call('open', {'side': 'a', 'path': str(source)})
        compare.call('open', {'side': 'b', 'path': str(source)})
        options = {'pageA': 0, 'pageB': 0, 'dpi': 150, 'threshold': 0, 'offsetXmm': 0, 'offsetYmm': 0, 'ignored': []}
        for index in range(len(a['pages'])):
            report = compare.compare({**options, 'pageA': index, 'pageB': index})
            assert report['changedPixels'] == 0 and not report['regions'], 'Self-comparison was not zero'
        result['allPagesSelfComparison150Dpi'] = True
        result['pageCount'] = len(a['pages'])
        tested = [150]
        for dpi in [300, 600]:
            p = a['pages'][0]
            w, h = round(p['width']*dpi/72), round(p['height']*dpi/72)
            if w*h <= 600_000_000 and max(w, h) <= 60_000:
                assert compare.compare({**options, 'dpi': dpi})['changedPixels'] == 0, 'High DPI self-comparison failed'
                tested.append(dpi)
        result['firstPageStrictDpiChecks'] = tested
        preview = compare.call('preview', {'options': options, 'width': 800})
        assert preview['a']['dataUrl'] == preview['b']['dataUrl'], 'Preview equality failed'
        del preview
        # Append our own small opaque color mark to a COPY, preserving the input.
        reader = PdfReader(str(source))
        writer = PdfWriter(clone_from=reader)
        page = writer.pages[0]
        box = page.cropbox
        x, y = float(box.left)+float(box.width)*.47, float(box.bottom)+float(box.height)*.53
        mark = DecodedStreamObject()
        mark.set_data(f'q 1 1 1 rg {x:.5f} {y:.5f} 12 12 re f 0.85 0 0.65 rg {x+2:.5f} {y+2:.5f} 7 7 re f Q'.encode('ascii'))
        previous = page.get('/Contents')
        contents = previous.get_object() if previous else ArrayObject()
        if not isinstance(contents, ArrayObject):
            contents = ArrayObject([previous])
        page[NameObject('/Contents')] = ArrayObject([*contents, writer._add_object(mark)])
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(prefix='private-controlled-', suffix='.pdf', dir=output.parent, delete=False) as handle:
            derivative = Path(handle.name).resolve()
            assert derivative.is_relative_to(output.parent.resolve())
            writer.write(handle)
        compare.call('open', {'side': 'b', 'path': str(derivative)})
        changed = compare.compare(options)
        assert changed['changedPixels'] > 0 and changed['regions'], 'Controlled visible change was missed'
        assert sum(r['pixels'] for r in changed['regions']) == changed['changedPixels'], 'Incomplete region accounting'
        result['controlledCopyChangeDetected'] = True
        # This is a compatibility/controlled-change check, not a real revision benchmark.
        opened = main.call('open_document', {'path': str(source)})
        page_ref = {'documentId': opened['id'], 'pageIndex': 0, 'rotation': 0}
        first = main.call('render_page', {'page': page_ref, 'targetWidth': 500})['dataUrl']
        compare.close()
        second = main.call('render_page', {'page': page_ref, 'targetWidth': 500})['dataUrl']
        assert hashlib.sha256(first.encode()).digest() == hashlib.sha256(second.encode()).digest(), 'Main source changed after comparison shutdown'
        result['mainRendererSurvivesComparisonShutdown'] = True
        result['status'] = 'PASS'
    except Exception as error:
        result.update(status='FAIL', failureType=type(error).__name__)
    finally:
        for worker in [compare, main]:
            if worker:
                worker.close()
        if derivative and derivative.exists():
            assert derivative.is_relative_to(output.parent.resolve())
            derivative.unlink()
        result['originalBytesUnchanged'] = hashlib.sha256(source.read_bytes()).digest() == before
        if not result['originalBytesUnchanged']:
            result['status'] = 'FAIL'
        result['privateDerivativeRemoved'] = not derivative or not derivative.exists()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    return result['status'] == 'PASS'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['pdf', 'exe', 'dll', 'output']:
        parser.add_argument('--'+name, required=True, type=Path)
    args = parser.parse_args()
    assert args.pdf.resolve().is_file() and args.pdf.suffix.lower() == '.pdf'
    raise SystemExit(0 if run(args.pdf.resolve(), args.exe.resolve(), args.dll.resolve(), args.output.resolve()) else 1)
