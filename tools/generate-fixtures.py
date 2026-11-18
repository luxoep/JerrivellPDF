#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Generate small, deterministic PDF fixtures using only the Python standard library.

The PDF objects, text, vector artwork, and annotations are authored for Rivuleaf PDF.
No third-party PDF, font file, image, JavaScript, or embedded attachment is used.
Run from any directory: python tools/generate-fixtures.py [--check].
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def pdf_string(value: str) -> str:
    value.encode("ascii")
    return "(" + value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ")"


class Pdf:
    """A deliberately small writer for these synthetic, unencrypted fixtures."""

    def __init__(self) -> None:
        self.objects: list[bytes | None] = []

    def reserve(self) -> int:
        self.objects.append(None)
        return len(self.objects)

    def set(self, number: int, body: str | bytes) -> None:
        self.objects[number - 1] = body.encode("ascii") if isinstance(body, str) else body

    def add(self, body: str | bytes) -> int:
        number = self.reserve()
        self.set(number, body)
        return number

    def stream(self, content: str, extra: str = "") -> int:
        data = content.encode("ascii")
        return self.add(
            f"<< /Length {len(data)} {extra} >>\nstream\n".encode("ascii")
            + data
            + b"\nendstream"
        )

    def finish(self, root: int, info: int) -> bytes:
        result = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
        offsets = [0]
        for number, body in enumerate(self.objects, start=1):
            if body is None:
                raise ValueError(f"Uninitialized object: {number}")
            offsets.append(len(result))
            result += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
        xref_offset = len(result)
        result += f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode("ascii")
        for offset in offsets[1:]:
            result += f"{offset:010d} 00000 n \n".encode("ascii")
        result += (
            f"trailer\n<< /Size {len(offsets)} /Root {root} 0 R /Info {info} 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
        for number, offset in enumerate(offsets[1:], start=1):
            if not result[offset:].startswith(f"{number} 0 obj\n".encode("ascii")):
                raise AssertionError("Incorrect cross-reference offset")
        return bytes(result)


INK = "0.11 0.17 0.20"
TEAL = "0.08 0.43 0.40"
MUTED = "0.38 0.44 0.47"
PAPER = "0.965 0.973 0.969"


def text(x: float, y: float, value: str, size: int = 12, bold: bool = False, color: str = INK) -> str:
    font = "F2" if bold else "F1"
    return f"BT /{font} {size} Tf {color} rg 1 0 0 1 {x:g} {y:g} Tm {pdf_string(value)} Tj ET\n"


def rect(x: float, y: float, width: float, height: float, color: str, stroke: bool = False) -> str:
    operator = "RG" if stroke else "rg"
    paint = "S" if stroke else "f"
    return f"q {color} {operator} 1 w {x:g} {y:g} {width:g} {height:g} re {paint} Q\n"


def line(x1: float, y1: float, x2: float, y2: float, color: str = MUTED) -> str:
    return f"q {color} RG 1 w {x1:g} {y1:g} m {x2:g} {y2:g} l S Q\n"


def page_frame(width: int, height: int, number: int, label: str) -> str:
    return (
        rect(0, 0, width, height, "1 1 1")
        + text(42, height - 42, "RIVULEAF / PDF", 10, True, TEAL)
        + text(42, 24, label, 9, color=MUTED)
        + text(width - 70, 24, f"{number:02}", 9, color=MUTED)
        + line(42, 43, width - 42, 43, "0.84 0.88 0.87")
    )


def sample_pages() -> list[dict]:
    first = page_frame(595, 842, 1, "Original synthetic fixture - GPL-3.0-or-later")
    first += text(42, 744, "Make room for clarity.", 29, True)
    first += text(42, 711, "A small document for a real PDF workflow.", 13, color=MUTED)
    first += rect(42, 584, 511, 96, PAPER)
    first += text(58, 653, "01 / WELCOME", 10, True, TEAL)
    first += text(58, 627, "Open, search, organize, and save a new copy.", 13)
    first += text(58, 605, "Search token: aurora", 12, True)
    first += text(42, 543, "A document with more than one page", 18, True)
    first += text(42, 513, "This file contains three pages with different geometry.")
    first += text(42, 492, "The next page is landscape; the last has a rotation flag.")
    first += text(42, 471, "A note annotation is attached near the welcome panel.")
    for x, number, label, color in [
        (42, "1", "PORTRAIT", "0.88 0.95 0.92"),
        (217, "2", "LANDSCAPE", "0.92 0.93 0.98"),
        (392, "3", "ROTATED", "0.98 0.94 0.86"),
    ]:
        first += rect(x, 332, 161, 100, color)
        first += text(x + 16, 385, number, 29, True)
        first += text(x + 16, 354, label, 10, True)
    first += text(42, 290, "Page operations checklist", 16, True)
    for index, value in enumerate([
        "Move page 3 to the beginning, then undo.",
        "Rotate a page by 90 degrees, then undo.",
        "Delete page 2 and save to a new filename.",
        "Merge second.pdf and confirm five pages in total.",
        "Export a PNG and compare it with the on-screen page.",
    ]):
        first += text(42, 262 - 23 * index, f"{index + 1}. {value}", 11)
    first += text(42, 98, "Rivuleaf PDF fixture / alpha / PAGE-ONE", 10, color=MUTED)

    second = page_frame(842, 595, 2, "Landscape - 842 x 595 PDF points")
    second += text(42, 503, "A wider view.", 29, True)
    second += text(42, 473, "A synthetic planning table. Every value is invented.", 13, color=MUTED)
    second += rect(42, 393, 758, 44, TEAL)
    for x, title in [(58, "WORKSTREAM"), (330, "STATUS"), (550, "NEXT STEP")]:
        second += text(x, 410, title, 11, True, "1 1 1")
    for row, values in enumerate([
        ("Reading", "Ready to explore", "Search the document"),
        ("Page organization", "Ready to explore", "Try moving a page"),
        ("File output", "Ready to explore", "Save a copy"),
    ]):
        y = 343 - row * 50
        second += rect(42, y, 758, 50, PAPER if row % 2 == 0 else "1 1 1")
        for x, value in zip((58, 330, 550), values):
            second += text(x, y + 19, value, 12)
        second += line(42, y, 800, y, "0.84 0.88 0.87")
    second += text(42, 190, "Search token: aurora", 12, True)
    second += text(42, 161, "The table uses ordinary text and vector rectangles, not a screenshot.", 12)
    second += text(42, 118, "Back to the welcome page", 11, color=TEAL)
    second += line(42, 114, 185, 114, TEAL)
    second += text(42, 77, "Rivuleaf PDF fixture / beta / PAGE-TWO", 10, color=MUTED)

    third = "q 0 1 -1 0 420 0 cm\n" + page_frame(595, 420, 3, "MediaBox 420 x 595 / Rotate 90")
    third += text(42, 322, "A different angle.", 28, True)
    third += text(42, 289, "This page has an explicit /Rotate 90 entry.", 12)
    third += text(42, 267, "Its content transform keeps the initial view upright.", 12)
    third += rect(42, 136, 226, 93, "0.88 0.95 0.92")
    third += text(58, 193, "Search token: aurora", 12, True)
    third += text(58, 164, "A quarter-turn is still a page.", 11)
    third += "q 0.08 0.43 0.40 RG 5 w 355 157 m 438 157 l 438 211 l S 426 199 m 438 211 l 450 199 l S Q\n"
    third += text(42, 88, "Rivuleaf PDF fixture / gamma / PAGE-THREE", 10, color=MUTED)
    third += "Q\n"
    return [
        {"width": 595, "height": 842, "rotation": 0, "title": "Welcome", "content": first, "note": True},
        {"width": 842, "height": 595, "rotation": 0, "title": "Landscape table", "content": second, "link": True},
        {"width": 420, "height": 595, "rotation": 90, "title": "Rotated page", "content": third},
    ]


def second_pages() -> list[dict]:
    pages = []
    for number, (title, marker) in enumerate([
        ("Bring documents together.", "MERGE-ONE"),
        ("Keep the order intentional.", "MERGE-TWO"),
    ], start=1):
        content = page_frame(612, 792, number, "Merge fixture - 612 x 792 PDF points")
        content += text(42, 695, title, 26, True)
        content += text(42, 658, "This is an original synthetic document for Rivuleaf PDF.", 12, color=MUTED)
        content += rect(42, 485, 528, 117, PAPER)
        content += text(60, 567, f"DOCUMENT TWO / PAGE {number}", 11, True, TEAL)
        content += text(60, 534, marker, 21, True)
        content += text(42, 438, "Search token: horizon", 12, True)
        content += text(42, 407, "Append this file after sample.pdf to produce five pages.", 12)
        content += text(42, 383, "Reopen the saved copy and check both unique merge markers.", 12)
        content += text(42, 105, f"Rivuleaf PDF fixture / second document / {marker}", 10, color=MUTED)
        pages.append({"width": 612, "height": 792, "rotation": 0, "title": marker, "content": content})
    return pages


def build_document(pages: list[dict], title: str) -> bytes:
    pdf = Pdf()
    catalog = pdf.reserve()
    page_tree = pdf.reserve()
    regular = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    bold = pdf.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    page_numbers = [pdf.reserve() for _ in pages]
    for spec, page_number in zip(pages, page_numbers):
        content = pdf.stream(spec["content"])
        annotations = []
        if spec.get("note"):
            appearance = pdf.stream(
                "q 0.98 0.76 0.28 rg 1 1 22 22 re f 0.48 0.32 0.04 RG 1 w 1 1 22 22 re S "
                "5 16 m 18 16 l S 5 11 m 18 11 l S 5 6 m 14 6 l S Q\n",
                "/Type /XObject /Subtype /Form /FormType 1 /BBox [0 0 24 24] /Resources << >>",
            )
            annotation = pdf.add(
                f"<< /Type /Annot /Subtype /Text /Rect [519 648 543 672] /P {page_number} 0 R "
                "/Name /Note /Open false /F 4 /C [0.98 0.76 0.28] "
                f"/AP << /N {appearance} 0 R >> "
                f"/T {pdf_string('Rivuleaf PDF fixture')} "
                f"/Contents {pdf_string('Original sample note. Verify this annotation survives a save-copy workflow.')} >>"
            )
            annotations.append(annotation)
        if spec.get("link"):
            annotations.append(pdf.add(
                f"<< /Type /Annot /Subtype /Link /Rect [42 111 190 132] /P {page_number} 0 R "
                f"/Border [0 0 0] /Dest [{page_numbers[0]} 0 R /Fit] >>"
            ))
        annots = "/Annots [" + " ".join(f"{item} 0 R" for item in annotations) + "]" if annotations else ""
        pdf.set(page_number,
            f"<< /Type /Page /Parent {page_tree} 0 R "
            f"/MediaBox [0 0 {spec['width']} {spec['height']}] /Rotate {spec['rotation']} "
            f"/Resources << /Font << /F1 {regular} 0 R /F2 {bold} 0 R >> >> "
            f"/Contents {content} 0 R {annots} >>"
        )
    outlines = pdf.reserve()
    entries = [pdf.reserve() for _ in pages]
    for index, (entry, page_number, spec) in enumerate(zip(entries, page_numbers, pages)):
        previous = f"/Prev {entries[index - 1]} 0 R " if index > 0 else ""
        following = f"/Next {entries[index + 1]} 0 R " if index + 1 < len(entries) else ""
        pdf.set(entry,
            f"<< /Title {pdf_string(spec['title'])} /Parent {outlines} 0 R {previous}{following}"
            f"/Dest [{page_number} 0 R /Fit] >>"
        )
    pdf.set(outlines, f"<< /Type /Outlines /First {entries[0]} 0 R /Last {entries[-1]} 0 R /Count {len(entries)} >>")
    pdf.set(page_tree, f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(f'{p} 0 R' for p in page_numbers)}] >>")
    pdf.set(catalog, f"<< /Type /Catalog /Pages {page_tree} 0 R /Outlines {outlines} 0 R /Lang (en-US) >>")
    info = pdf.add(
        f"<< /Title {pdf_string(title)} /Author (Rivuleaf PDF contributors) "
        "/Creator (Rivuleaf PDF original fixture generator) /Producer (Python standard library) "
        "/Subject (Synthetic test content; GPL-3.0-or-later; source: tools/generate-fixtures.py) >>"
    )
    return pdf.finish(catalog, info)


def artifacts() -> dict[str, bytes]:
    specifications = {"sample.pdf": sample_pages(), "second.pdf": second_pages()}
    files = {
        name: build_document(pages, "Rivuleaf PDF sample" if name == "sample.pdf" else "Rivuleaf PDF merge sample")
        for name, pages in specifications.items()
    }
    manifest = {
        "schema_version": 1,
        "origin": "Original synthetic content authored for Rivuleaf PDF; no imported document or embedded font file.",
        "license": "GPL-3.0-or-later",
        "generator": "tools/generate-fixtures.py",
        "encrypted": False,
        "javascript": False,
        "files": [
            {
                "name": name,
                "sha256": hashlib.sha256(files[name]).hexdigest(),
                "bytes": len(files[name]),
                "page_count": len(pages),
                "media_boxes": [[0, 0, page["width"], page["height"]] for page in pages],
                "rotations": [page["rotation"] for page in pages],
                "search_word": "aurora" if name == "sample.pdf" else "horizon",
                "search_occurrences_case_sensitive": len(pages),
                "note_annotations": 1 if name == "sample.pdf" else 0,
                "internal_link_annotations": 1 if name == "sample.pdf" else 0,
                "outline_entries": len(pages),
            }
            for name, pages in specifications.items()
        ],
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parent.parent / "fixtures")
    parser.add_argument("--check", action="store_true", help="Check that committed fixtures match the generator; do not write.")
    args = parser.parse_args()
    files = artifacts()
    if args.check:
        mismatches = [name for name, data in files.items() if not (args.output_dir / name).is_file() or (args.output_dir / name).read_bytes() != data]
        if mismatches:
            print("Fixture check failed: " + ", ".join(mismatches))
            return 1
        print("Fixtures are reproducible: sample.pdf (3 pages), second.pdf (2 pages), manifest.json")
        return 0
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        path = args.output_dir / name
        path.write_bytes(data)
        print(f"Wrote {path} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
