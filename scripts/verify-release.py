#!/usr/bin/env python3
"""Verify the locally built, installed and source-archived development handoff.

SPDX-License-Identifier: MIT OR Apache-2.0
Uses Python 3.11+ standard library only; does not alter the artifacts.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'release'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def directory_hashes(path):
    return {file.relative_to(path).as_posix(): sha256(file) for file in path.rglob('*') if file.is_file()}


def main():
    manifest = json.loads((RELEASE / 'release-manifest.json').read_text(encoding='utf-8-sig'))
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text(encoding='utf-8-sig'))
    assert manifest['version'] == config['version']
    artifacts = {}
    for key in ['installer', 'source', 'thirdPartySourceSupplement', 'installedExecutable']:
        record = manifest.get(key)
        assert record, f'Missing release record: {key}'
        path = (RELEASE / record['file']).resolve()
        assert path.is_relative_to(RELEASE.resolve()), 'Artifact path escaped release directory'
        assert sha256(path) == record['sha256'], f'Artifact hash mismatch: {key}'
        artifacts[key] = {'file': record['file'], 'sha256': record['sha256'], 'bytes': path.stat().st_size}
    executable = ROOT / 'src-tauri/target/release/jerrivell-pdf.exe'
    assert sha256(executable) == manifest['executableSha256']
    assert sha256(ROOT / 'src-tauri/Cargo.lock') == manifest['cargoLockSha256']
    assert sha256(ROOT / 'package-lock.json') == manifest['npmLockSha256']
    forbidden_extensions = {'.exe', '.dll', '.zip', '.tgz', '.ttf', '.ttc', '.otf', '.woff', '.woff2', '.pfx', '.p12', '.pem', '.key', '.pyc'}
    with zipfile.ZipFile(RELEASE / manifest['source']['file']) as archive:
        entries = archive.namelist()
        assert len(entries) == len(set(entries)), 'Duplicate source archive entry'
        for entry in entries:
            relative = Path(entry)
            assert not relative.is_absolute() and '..' not in relative.parts
            assert not set(relative.parts) & {'node_modules', 'target', 'release', 'test-results', '__pycache__', '.git'}
            assert relative.suffix.lower() not in forbidden_extensions, entry
            if relative.suffix.lower() == '.pdf':
                assert entry in {'fixtures/sample.pdf', 'fixtures/second.pdf'}, entry
            source = (ROOT / relative).resolve()
            assert source.is_relative_to(ROOT), entry
            assert hashlib.sha256(archive.read(entry)).hexdigest() == sha256(source), f'Source archive differs from workspace: {entry}'
    installed = (RELEASE / manifest['installedExecutable']['file']).parent
    # Tauri patches the bundle-type marker for NSIS, then restores the standalone
    # target executable. Verify the exact expected difference instead of assuming
    # their SHA-256 values must match or accepting arbitrary binary differences.
    built_bytes = executable.read_bytes()
    installed_bytes = (installed / 'jerrivell-pdf.exe').read_bytes()
    bundle_difference = 'identical'
    if built_bytes != installed_bytes:
        original_marker = b'__TAURI_BUNDLE_TYPE_VAR_UNK'
        installer_marker = b'__TAURI_BUNDLE_TYPE_VAR_NSS'
        assert built_bytes.count(original_marker) == installed_bytes.count(installer_marker) == 1, 'Unexpected Tauri bundle marker'
        assert installed_bytes.replace(installer_marker, original_marker, 1) == built_bytes, 'Installed executable differs beyond the Tauri NSIS marker'
        bundle_difference = 'Tauri bundle marker UNK -> NSS (three bytes only)'
    expected_licenses = directory_hashes(ROOT / 'licenses')
    expected_pdfium = directory_hashes(ROOT / 'src-tauri/resources/pdfium')
    assert expected_licenses == directory_hashes(installed / 'legal/licenses'), 'Installed license resources differ'
    assert expected_pdfium == directory_hashes(installed / 'pdfium'), 'Installed PDFium resources differ'
    for relative in ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_NOTICES.md']:
        assert sha256(ROOT / relative) == sha256(installed / 'legal' / relative)
    result = {'status': 'PASS', 'version': manifest['version'], 'sourceFiles': len(entries), 'sourceArchiveMatchesWorkspace': True,
              'installedExecutableDifference': bundle_difference,
              'sourceExclusions': 'Only the two original fixture PDFs; no native binaries, fonts, private-key containers or build/test caches',
              'installedResources': {'licenseFiles': len(expected_licenses), 'pdfiumFiles': len(expected_pdfium), 'rootLegalFiles': 4},
              'artifacts': artifacts}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (AssertionError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f'Release verification failed: {error}', file=sys.stderr)
        sys.exit(1)
