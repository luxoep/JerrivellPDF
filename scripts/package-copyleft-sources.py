#!/usr/bin/env python3
"""Prepare exact MPL crate and NSIS source archives for the local release.

SPDX-License-Identifier: MIT OR Apache-2.0
Original project material is MIT OR Apache-2.0; upstream obligations remain separate.
Uses Python 3.11+ standard library. Originals keep their own licenses.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parents[1]
MPL_NAMES = {"cssparser", "cssparser-macros", "dtoa-short", "option-ext", "selectors"}
NSIS_URL = "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13-src.tar.bz2"
NSIS_SHA256 = "a8ffe024602d46b6d766f9e1ce30c324ad2a24daeacd3efc2642d436a0c157ac"


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(url: str, target: Path, expected: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(Request(url, headers={"User-Agent": "JerrivellPDF-source-provenance/0.1"}), timeout=45) as response:
        data = response.read(32 * 1024 * 1024 + 1)
    if len(data) > 32 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Source archive hash/size mismatch: " + url)
    target.write_bytes(data)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-missing", action="store_true", help="Fetch missing source archives from recorded official endpoints.")
    args = parser.parse_args()
    inventory = json.loads((ROOT / "licenses/inventory.json").read_text(encoding="utf-8-sig"))
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8-sig"))
    for key, path in (("cargoLockSha256", "src-tauri/Cargo.lock"), ("npmLockSha256", "package-lock.json")):
        if digest(ROOT / path) != inventory[key]:
            raise ValueError("License inventory no longer matches lockfile: " + path)
    destination = ROOT / "release/third-party-sources"
    destination.mkdir(parents=True, exist_ok=True)
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    entries = []
    selected = [entry for entry in inventory["cargo"] if entry["name"] in MPL_NAMES and entry.get("license") == "MPL-2.0"]
    if {entry["name"] for entry in selected} != MPL_NAMES or len(selected) != len(MPL_NAMES):
        raise ValueError("MPL dependency set changed; review script and notices before packaging.")
    for entry in selected:
        name, version = entry["name"], entry["version"]
        filename = f"{name}-{version}.crate"
        expected = entry["registryArchiveSha256"]
        target = destination / "mpl-crates" / filename
        source_url = f"https://crates.io/api/v1/crates/{name}/{version}/download"
        if not target.is_file() or digest(target) != expected:
            cached = [p for p in (cargo_home / "registry/cache").glob("*/" + filename) if digest(p) == expected]
            if cached:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(cached[0], target)
            elif args.download_missing:
                download(source_url, target, expected)
            else:
                raise FileNotFoundError(f"Missing exact crate {filename}; run with --download-missing.")
        entries.append({"component": name, "version": version, "license": "MPL-2.0", "path": target.relative_to(destination).as_posix(), "sourceUrl": source_url, "repository": entry.get("repository"), "vcs": entry.get("vcs"), "sha256": digest(target), "unchangedSourceArchive": True})
    nsis = destination / "nsis-3.13-src.tar.bz2"
    if not nsis.is_file() or digest(nsis) != NSIS_SHA256:
        if not args.download_missing:
            raise FileNotFoundError("Missing NSIS source; run with --download-missing.")
        download(NSIS_URL, nsis, NSIS_SHA256)
    entries.append({"component": "NSIS", "version": "3.13", "license": "zlib/libpng; bzip2; CPL-1.0 with NSIS LZMA linking exception", "path": nsis.name, "sourceUrl": NSIS_URL, "sha256": digest(nsis), "upstreamChecksumPage": "https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-src.tar.bz2/download", "unchangedSourceArchive": True})
    manifest = {"product": "Jerrivell PDF", "version": config["version"], "purpose": "Exact source archives for identified MPL components and NSIS installer; original project material is separately MIT OR Apache-2.0.", "cargoLockSha256": inventory["cargoLockSha256"], "entries": entries}
    (destination / "source-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (destination / "README.md").write_text("""# Third-party source archives

These are unchanged source archives for the exact identified MPL-2.0 crates and NSIS 3.13. They retain their own licenses, copyright notices and source headers. A `.crate` file is a gzip-compressed tar archive containing the published package's source. The NSIS tar.bz2 includes the LZMA compression module and its CPL-1.0 terms/linking exception. See source-manifest.json for exact versions, original source URLs and SHA-256 values.

These archives accompany the local Jerrivell PDF development handoff. The project's own preferred source/configuration/build instructions are supplied separately. This selection covers the components listed in its manifest and does not replace full release/source availability review. The original project uses MIT OR Apache-2.0. Preserve MPL and installer source rights when further distributing these archives; do not relabel third-party files under the project license.

Recreate with Python 3.11+: `python scripts/package-copyleft-sources.py --download-missing`. Once the archives exist and match, no network is needed.
""", encoding="utf-8")
    output = ROOT / "release" / f"JerrivellPDF-{config['version']}-third-party-sources.zip"
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in [destination / "README.md", destination / "source-manifest.json", *(destination / item["path"] for item in entries)]:
            info = zipfile.ZipInfo("third-party-sources/" + entry.relative_to(destination).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, entry.read_bytes())
    print(json.dumps({"status": "PASS", "archives": len(entries), "zip": str(output), "sha256": digest(output)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
