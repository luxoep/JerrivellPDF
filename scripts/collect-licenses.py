#!/usr/bin/env python3
"""Collect original notice files from the packages actually present on this machine.

This is a provenance/inventory helper, not an SPDX compatibility decision engine.
Requires Python >= 3.11, npm ci and Cargo's downloaded registry source cache.
No network access, package installation, or source-cache modification is performed.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "licenses"
PREFIXES = ("license", "licence", "copying", "notice", "unlicense", "copyright", "third-party", "third_party")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def slug(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.+-]", "_", value)


def notices(directory: Path, explicit: str | None = None) -> list[Path]:
    paths = {
        path for path in directory.rglob("*")
        if path.is_file() and path.name.lower().startswith(PREFIXES)
        and "node_modules" not in path.relative_to(directory).parts
    }
    if explicit:
        path = (directory / explicit).resolve()
        if path.is_file() and path.is_relative_to(directory.resolve()):
            paths.add(path)
    return sorted(paths)


def copy_notices(directory: Path, files: list[Path], destination: Path) -> list[dict]:
    result = []
    for path in files:
        relative = path.relative_to(directory)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        data = path.read_bytes()
        target.write_bytes(data)
        result.append({"path": target.relative_to(ROOT).as_posix(), "sha256": sha256(data)})
    return result


def main() -> None:
    cargo_lock_file = ROOT / "src-tauri/Cargo.lock"
    npm_lock_file = ROOT / "package-lock.json"
    cargo_lock = tomllib.loads(cargo_lock_file.read_text(encoding="utf-8"))
    npm_lock = json.loads(npm_lock_file.read_text(encoding="utf-8"))
    cargo_home = Path(os.environ.get("CARGO_HOME", str(Path.home() / ".cargo")))
    registries = cargo_home / "registry/src"
    supplemental_file = DEST / "upstream-manifest.json"
    supplements = json.loads(supplemental_file.read_text(encoding="utf-8")) if supplemental_file.exists() else {}

    def attach_supplement(ecosystem: str, entry: dict) -> None:
        supplement = supplements.get(ecosystem + "/" + entry["name"] + "@" + entry["version"])
        if not supplement:
            return
        for item in supplement:
            path = (ROOT / item["path"]).resolve()
            if not path.is_relative_to(DEST.resolve()) or sha256(path.read_bytes()) != item["sha256"]:
                raise ValueError("Supplemental notice file hash/path mismatch: " + item["path"])
        entry["supplementalFiles"] = supplement
        if not entry.get("files"):
            entry["status"] = "original-upstream-notices-copied"
    cargo_entries, npm_entries = [], []
    for locked in cargo_lock["package"]:
        if not locked.get("source", "").startswith("registry+"):
            continue
        name, version = locked["name"], locked["version"]
        entry = {"name": name, "version": version, "registrySource": locked["source"],
                 "registryArchiveSha256": locked.get("checksum")}
        candidates = list(registries.glob(f"*/{name}-{version}"))
        if not candidates:
            entry["status"] = "not-in-local-source-cache"
        else:
            directory = candidates[0]
            metadata = tomllib.loads((directory / "Cargo.toml").read_text(encoding="utf-8"))["package"]
            entry.update({key: metadata.get(key) for key in ("license", "authors", "repository")})
            vcs = directory / ".cargo_vcs_info.json"
            if vcs.is_file():
                entry["vcs"] = json.loads(vcs.read_text(encoding="utf-8"))
            files = notices(directory, metadata.get("license-file"))
            entry["files"] = copy_notices(directory, files, DEST / "rust" / f"{name}-{version}")
            entry["status"] = "original-notices-copied" if files else "upstream-notice-supplement-required"
            attach_supplement("rust", entry)
        cargo_entries.append(entry)
    for relative, locked in npm_lock["packages"].items():
        if not relative:
            continue
        directory = ROOT / relative
        if not (directory / "package.json").is_file():
            continue  # Optional packages for other OS/CPU are not distributed here.
        metadata = json.loads((directory / "package.json").read_text(encoding="utf-8"))
        name, version = metadata["name"], metadata["version"]
        files = notices(directory)
        entry = {"name": name, "version": version, "license": metadata.get("license"),
            "repository": metadata.get("repository"), "developmentDependency": locked.get("dev", False),
            "registryUrl": locked.get("resolved"), "registryIntegrity": locked.get("integrity"),
            "files": copy_notices(directory, files, DEST / "npm" / slug(f"{name}-{version}")),
            "status": "original-notices-copied" if files else "upstream-notice-supplement-required"}
        attach_supplement("npm", entry)
        npm_entries.append(entry)
    inventory = {"scope": "All Cargo.lock registry entries and locally installed npm lock packages, including build/dev dependencies. An uncached lock entry is not proof that it ships in the Windows binary.",
        "cargoLockSha256": sha256(cargo_lock_file.read_bytes()),
        "npmLockSha256": sha256(npm_lock_file.read_bytes()), "cargo": cargo_entries, "npm": npm_entries}
    DEST.mkdir(exist_ok=True)
    (DEST / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"cargoLockEntries": len(cargo_entries), "cargoCached": sum("files" in e for e in cargo_entries),
        "npmInstalled": len(npm_entries), "noticeFiles": sum(len(e.get("files", [])) for e in cargo_entries + npm_entries),
        "supplementRequired": [e["name"] + "@" + e["version"] for e in cargo_entries + npm_entries
                               if e["status"] == "upstream-notice-supplement-required"]}, indent=2))


if __name__ == "__main__":
    main()
