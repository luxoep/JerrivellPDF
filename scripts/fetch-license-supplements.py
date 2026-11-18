#!/usr/bin/env python3
"""Restore pinned license supplements; bytes must match the committed manifest.

Python >= 3.11. This helper restores license texts from pinned URLs or verified
source archives. It never executes or extracts downloaded programs. Local npm
source references require npm ci to have been run first.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEST = (ROOT / "licenses").resolve()


def main() -> None:
    manifest = json.loads((DEST / "upstream-manifest.json").read_text(encoding="utf-8"))
    processed = set()
    for entries in manifest.values():
        for entry in entries:
            target = (ROOT / entry["path"]).resolve()
            if target in processed:
                continue
            processed.add(target)
            if not target.is_relative_to((DEST / "upstream").resolve()):
                raise ValueError("Supplemental destination must remain in licenses/upstream")
            expected = entry["sha256"]
            if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
                print("Verified:", target.name)
                continue
            if entry.get("sourceArchiveUrl"):
                url = entry["sourceArchiveUrl"]
                parsed = urlparse(url)
                if parsed.scheme != "https" or parsed.hostname != "github.com":
                    raise ValueError("Unexpected source archive: " + url)
                with urlopen(Request(url, headers={"User-Agent": "AuraPdf-license-provenance/0.1"}), timeout=45) as response:
                    archive = response.read(16 * 1024 * 1024 + 1)
                if len(archive) > 16 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != entry["sourceArchiveSha256"]:
                    raise ValueError("Source archive hash mismatch: " + url)
                with zipfile.ZipFile(io.BytesIO(archive)) as package:
                    member = package.getinfo(entry["sourceArchiveMember"])
                    if member.file_size > 2 * 1024 * 1024:
                        raise ValueError("License archive member exceeds limit")
                    data = package.read(member)
            elif entry.get("sourceUrl"):
                url = entry["sourceUrl"]
                parsed = urlparse(url)
                if parsed.scheme != "https" or parsed.hostname not in {"raw.githubusercontent.com", "www.mozilla.org", "www.apache.org"}:
                    raise ValueError("Unexpected license source: " + url)
                with urlopen(Request(url, headers={"User-Agent": "AuraPdf-license-provenance/0.1"}), timeout=45) as response:
                    data = response.read(2 * 1024 * 1024 + 1)
            else:
                source = (ROOT / entry["sourceFile"]).resolve()
                if not source.is_relative_to((ROOT / "node_modules").resolve()):
                    raise ValueError("Unexpected local source: " + str(source))
                data = source.read_bytes()
            if len(data) > 2 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
                raise ValueError("License source hash mismatch; existing file was not replaced: " + str(target))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            print("Restored:", target.name)


if __name__ == "__main__":
    main()
