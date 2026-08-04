#!/usr/bin/env python3
"""Create the minimal directory used by the scanner from the monthly XLS file.

The source workbook stays on the computer.  This exporter deliberately keeps
only the values needed by the app: recipient name and construction-site/unit.
It never copies mobile numbers, extensions, addresses, or the original XLS.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

try:
    import xlrd
except ImportError as exc:  # pragma: no cover - shown to the operator
    raise SystemExit("This tool needs xlrd. Install it with: pip install xlrd==2.0.1") from exc


DEFAULT_SHEET = "\u4eba\u54e1\u806f\u7d61\u96fb\u8a71(\u5c0f)"
NAME_RE = re.compile(r"^[\u3400-\u9fff]{2,6}$")
HEADER_WORDS = {"\u8077\u7a31", "\u59d3\u540d", "\u7c21\u78bc", "\u884c\u52d5\u96fb\u8a71", "\u5206\u6a5f"}
SITE_NAME_OVERRIDES = {
    "MVPN:280": "\u9ad8\u6377RKC02",
    "MVPN\uff1a280": "\u9ad8\u6377RKC02",
    "MVPN\uff1a280\u3001281": "\u9ad8\u6377RKC02",
}


def clean(value: object) -> str:
    """Normalise a workbook cell without changing the original file."""
    text = "" if value is None else str(value)
    return "".join(text.replace("\u3000", " ").split()).strip()


def name_value(value: object) -> str:
    """Return a plausible Chinese recipient name, otherwise an empty string."""
    text = clean(value)
    return text if NAME_RE.fullmatch(text) and text not in HEADER_WORDS else ""


def canonical_site_name(value: str) -> str:
    """Apply confirmed manual corrections to site labels in the source sheet."""
    return SITE_NAME_OVERRIDES.get(value, value)


def unit_before_header(sheet: xlrd.sheet.Sheet, header_row: int, title_col: int) -> str:
    """Find the short unit/site title printed immediately above a mini table."""
    candidates: list[tuple[int, int, str]] = []
    for row in range(max(0, header_row - 3), header_row):
        text = clean(sheet.cell_value(row, title_col))
        if not text or text in HEADER_WORDS:
            continue
        # Address, phone, fax and person rows are intentionally excluded.
        # Many sites include a project number in their name, so digits alone are
        # not a reason to discard a heading.  Contact lines are identified by
        # their labels or their much longer length instead.
        if len(text) > 20 or "TEL" in text.upper() or "FAX" in text.upper():
            continue
        if not re.search(r"[\u3400-\u9fffA-Za-z]", text):
            continue
        candidates.append((row, len(text), text))
    if not candidates:
        return "\u672a\u8a2d\u5b9a\u5de5\u5730"
    # Unit titles are printed in the first column of the mini-table.  Prefer
    # the closest usable label, then the shorter label if a heading has wrapped.
    candidates.sort(key=lambda item: (-item[0], item[1]))
    return candidates[0][2]


def extract(source: Path, sheet_name: str, source_label: str) -> dict:
    book = xlrd.open_workbook(source)
    try:
        sheet = book.sheet_by_name(sheet_name)
    except xlrd.biffh.XLRDError as exc:
        available = ", ".join(book.sheet_names())
        raise ValueError(f"Worksheet not found: {sheet_name}. Available: {available}") from exc

    headers: list[tuple[int, int]] = []
    for row in range(sheet.nrows):
        for col in range(sheet.ncols - 1):
            if clean(sheet.cell_value(row, col)) == "\u8077\u7a31" and clean(sheet.cell_value(row, col + 1)) == "\u59d3\u540d":
                headers.append((row, col))

    if not headers:
        raise ValueError("No title/name table headers were found in the worksheet.")

    headers_by_col: dict[int, list[int]] = {}
    for row, col in headers:
        headers_by_col.setdefault(col, []).append(row)
    for rows in headers_by_col.values():
        rows.sort()

    units: list[dict] = []
    unit_ids: dict[str, str] = {}
    people: list[dict] = []

    def get_unit_id(unit: str) -> str:
        if unit not in unit_ids:
            unit_id = f"unit-{len(unit_ids) + 1:02d}"
            unit_ids[unit] = unit_id
            units.append({"id": unit_id, "name": unit})
        return unit_ids[unit]

    for row, col in headers:
        next_rows = [r for r in headers_by_col[col] if r > row]
        end_row = next_rows[0] if next_rows else sheet.nrows
        unit = canonical_site_name(unit_before_header(sheet, row, col))
        unit_id = get_unit_id(unit)
        for data_row in range(row + 1, end_row):
            person_name = name_value(sheet.cell_value(data_row, col + 1))
            if not person_name:
                continue
            people.append({
                "name": person_name,
                "unit": unit,
                "unitId": unit_id,
            })

    if not people:
        raise ValueError("No names were extracted. The worksheet layout may have changed.")

    return {"source": source_label, "units": units, "people": people}


def validation_summary(directory: dict) -> dict:
    names = [person["name"] for person in directory["people"]]
    units = {unit["id"] for unit in directory["units"]}
    missing_unit = sum(person["unitId"] not in units for person in directory["people"])
    return {
        "people": len(directory["people"]),
        "units": len(directory["units"]),
        "duplicate_name_entries": sum(count - 1 for count in Counter(names).values() if count > 1),
        "unassigned_site_entries": sum(person["unit"] == "\u672a\u8a2d\u5b9a\u5de5\u5730" for person in directory["people"]),
        "invalid_unit_references": missing_unit,
        "stored_fields": ["name", "unit", "unitId"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Extract name-to-site data from the monthly XLS phonebook.")
    parser.add_argument("input", type=Path, help="Path to the original monthly .xls file")
    parser.add_argument("--output", type=Path, required=True, help="Destination directory.json path")
    parser.add_argument("--sheet", default=DEFAULT_SHEET)
    parser.add_argument("--source", default="\u96fb\u8a71\u8868")
    parser.add_argument("--summary", action="store_true", help="Print a privacy-safe count-only validation summary")
    args = parser.parse_args()

    directory = extract(args.input, args.sheet, args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(directory, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.summary:
        print(json.dumps(validation_summary(directory), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
