#!/usr/bin/env python3
"""把「電話總表」PDF 轉成網站用的 data/directory.json。

版面說明：整頁是一個網格 —— 橫向 6 個單位區塊，每個區塊縱向再堆疊數個「單位段落」。
每個段落開頭是「單位名稱 + 地址 + TEL/FAX」，接著是表頭
（職稱 / 姓　名 / 簡碼 / 行動電話 / 分機）與人員資料列。

用 extract_words() 會把相鄰區塊的文字交錯黏在一起（例如總公司的地址會蓋到 CQ890 那欄），
所以這裡改成字元層級處理：
  1. 依 PDF 內容流順序把字元切成「文字段（run）」；
  2. 用每個 run 的第一個字元決定它屬於哪個區塊 / 哪一欄（跨欄溢出就不會亂跑）；
  3. 再依 y 座標把 run 併成列。

用法：
    pip install pdfplumber
    python3 tools/extract_pdf.py [來源.pdf] [輸出.json]
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PDF = ROOT / "電話總表115.07.16.pdf"
DEFAULT_OUT = ROOT / "data" / "directory.json"

# 6 個單位區塊的 x 邊界（由重複出現的表頭位置量得）
BLOCK_EDGES = [0.0, 145.5, 285.5, 423.0, 561.5, 700.5, 842.0]
COLS = ["title", "name", "code", "mobile", "ext"]

# 職稱欄裡真的是「職稱」的值；其餘（施工1組、測量、安衛、CQ891…）視為組別標籤，
# 會往下沿用到下一個標籤為止。
TITLES = {
    "董事長", "總經理", "營運長", "副總", "協理", "權任協理", "經理", "副理",
    "襄理", "主任", "副主任", "科長", "顧問", "機電顧問", "機電主任", "護理師",
}

# 職稱欄裡夾雜的異動註記，例如「7/31離職」「8/1報到」「8/1調」「7月底支援宿舍」
NOTE_RE = re.compile(
    r"\d{1,2}/\d{1,2}\s*(?:離職|報到|調動|調)"
    r"|\d{1,2}月底支援\S*"
    r"|\d{1,2}/\d{1,2}"
)

# 段落抬頭的三種文字：地址、電話、其他附註（MVPN 速撥碼等）
ADDR_RE = re.compile(r"[市縣].*[路街道段號里村]")
TEL_RE = re.compile(r"^(?:TEL|Tel|代表號)[：:]?\s*(.+)$")
FAX_RE = re.compile(r"^FAX[：:]?\s*(.+)$")

CJK = r"㐀-䶿一-鿿"


def block_of(x: float) -> int:
    for i in range(6):
        if BLOCK_EDGES[i] <= x < BLOCK_EDGES[i + 1]:
            return i
    return 5


def build_runs(chars):
    """把字元序列切成文字段：同一列、且 x 連續的字元算同一段。"""
    runs = []
    cur = None
    for c in chars:
        if not c["text"].strip():
            cur = None  # 全形空白（姓名中間的分隔）也視為斷點
            continue
        if (cur is not None
                and abs(c["top"] - cur["top"]) <= 2.0
                and -1.0 <= c["x0"] - cur["x1"] <= 3.0):
            cur["text"] += c["text"]
            cur["x1"] = c["x1"]
        else:
            cur = {"text": c["text"], "x0": c["x0"], "x1": c["x1"],
                   "top": c["top"], "size": c["size"]}
            runs.append(cur)
    return runs


def cluster_rows(items, tol=3.0):
    """依 top 把 run 併成列（同一列有時會差 ~1pt）。"""
    buckets = defaultdict(list)
    for it in items:
        buckets[round(it["top"], 1)].append(it)
    rows = []
    for key in sorted(buckets):
        if rows and key - rows[-1][0] <= tol:
            rows[-1][1].extend(buckets[key])
        else:
            rows.append([key, list(buckets[key])])
    return rows


def column_dividers(page):
    """從各區塊重複出現的表頭列推算欄位分界線。"""
    runs = build_runs(page.chars)
    per_block = defaultdict(list)
    for r in runs:
        per_block[block_of(r["x0"])].append(r)

    dividers = {}
    for b, rs in per_block.items():
        anchors = defaultdict(list)
        for _, row in cluster_rows(rs):
            row.sort(key=lambda r: r["x0"])
            joined = "".join(r["text"] for r in row)
            if "職稱" not in joined or "分機" not in joined:
                continue
            for r in row:
                for label, key in (("姓", "name"), ("簡碼", "code"),
                                   ("行動電話", "mobile"), ("分機", "ext")):
                    if r["text"].startswith(label):
                        anchors[key].append(r["x0"])
        if len(anchors) < 4:
            continue
        avg = {k: sum(v) / len(v) for k, v in anchors.items()}
        # 資料欄比表頭文字略寬，行動電話那欄左邊要多留一點
        dividers[b] = [avg["name"] - 1.5, avg["code"] - 0.5,
                       avg["mobile"] - 5.5, avg["ext"] - 0.5]
    return per_block, dividers


def split_note(title: str):
    """把職稱欄裡的異動註記拆出來，回傳 (職稱, 註記)。"""
    notes = NOTE_RE.findall(title)
    note = "".join(m.group() for m in NOTE_RE.finditer(title))
    cleaned = NOTE_RE.sub("", title).strip()
    for tail in ("離職", "報到", "調動", "調"):
        if cleaned.endswith(tail) and cleaned not in TITLES:
            note += tail
            cleaned = cleaned[: -len(tail)].strip()
    return cleaned, note


def parse(pdf_path: Path):
    page = pdfplumber.open(str(pdf_path)).pages[0]
    per_block, dividers = column_dividers(page)

    def col_of(b, x):
        for i, edge in enumerate(dividers[b]):
            if x < edge:
                return COLS[i]
        return COLS[4]

    units, people = [], []

    for b in sorted(per_block):
        rows = cluster_rows(per_block[b])
        # 表頭列的索引：每個表頭列代表一個新的單位段落
        header_idx = [
            i for i, (_, row) in enumerate(rows)
            if any(r["text"].startswith("職稱") for r in row)
            and any(r["text"].startswith("分機") for r in row)
        ]

        # 從表頭往上收抬頭列：含地址或 TEL/FAX/MVPN 就算抬頭，碰到資料列即停。
        def is_meta(row):
            return any(ADDR_RE.search(r["text"]) or TEL_RE.match(r["text"])
                       or FAX_RE.match(r["text"]) or "MVPN" in r["text"]
                       for r in row)

        meta_lo = []
        for hi in header_idx:
            lo = hi
            while lo > 0 and is_meta(rows[lo - 1][1]):
                lo -= 1
            meta_lo.append(lo)

        for n, hi in enumerate(header_idx):
            # 資料列到下一個段落的抬頭為止（不是到下一個表頭）
            end = meta_lo[n + 1] if n + 1 < len(header_idx) else len(rows)

            # --- 段落抬頭：單位名稱 / 地址 / 電話 ---
            meta_rows = [sorted(row, key=lambda r: r["x0"])
                         for _, row in rows[meta_lo[n]:hi]]

            address = tel = fax = ""
            unit_name = f"區塊{b}-{n}"
            skip = set()
            for ri, row in enumerate(meta_rows):
                for i, r in enumerate(row):
                    if ADDR_RE.search(r["text"]):
                        address = r["text"]
                        skip.add((ri, i))
                        if i:  # 單位名稱就在地址左邊、同一列
                            unit_name = row[i - 1]["text"]
                            skip.add((ri, i - 1))
                        break
                if address:
                    break

            extra = []
            for ri, row in enumerate(meta_rows):
                for i, r in enumerate(row):
                    if (ri, i) in skip:
                        continue
                    t = r["text"]
                    if TEL_RE.match(t):
                        tel = TEL_RE.match(t).group(1)
                    elif FAX_RE.match(t):
                        fax = FAX_RE.match(t).group(1)
                    else:
                        extra.append(t)

            unit = {
                "id": f"b{b}s{n}",
                "name": unit_name,
                "address": address,
                "tel": tel,
                "fax": fax,
                "note": " ".join(extra).strip(),
            }
            units.append(unit)

            # --- 人員列 ---
            group = ""
            for _, row in rows[hi + 1: end]:
                cells = defaultdict(list)
                for r in sorted(row, key=lambda r: r["x0"]):
                    cells[col_of(b, r["x0"])].append(r["text"])
                cell = {k: "".join(v).strip() for k, v in cells.items()}

                title_raw = cell.get("title", "")
                title, note = split_note(title_raw)
                if title and title not in TITLES:
                    group, title = title, ""

                name = cell.get("name", "").replace("　", "").strip()
                mobile = cell.get("mobile", "").strip()
                code = cell.get("code", "").strip()
                ext = cell.get("ext", "").strip()
                if not (name or mobile or code or ext):
                    continue

                people.append({
                    "name": name,
                    "title": title,
                    "group": group,
                    "code": code,
                    "mobile": mobile,
                    "ext": ext,
                    "note": note,
                    "unit": unit["name"],
                    "unitId": unit["id"],
                })

    return units, people


def main():
    pdf_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PDF
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUT

    units, people = parse(pdf_path)

    # 沒有姓名的列（例如「台北公司」的代表門號）當成單位層級的聯絡方式
    contacts, staff = [], []
    for p in people:
        if re.search(f"[{CJK}]", p["name"]):
            staff.append(p)
        elif p["mobile"] or p["code"]:
            contacts.append(p)

    for c in contacts:
        for u in units:
            if u["id"] == c["unitId"]:
                label = c["group"] or u["name"]
                bits = [x for x in (c["code"], c["mobile"]) if x]
                u["note"] = (u["note"] + f"  {label}代表：" + " / ".join(bits)).strip()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 維持 PDF 上的排列順序（同組別的人會排在一起），單位總覽看起來才跟紙本一致
    payload = {
        "source": pdf_path.name,
        "units": units,
        "people": staff,
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"單位 {len(units)} 個、人員 {len(staff)} 位 → {out_path}")
    for u in units:
        n = sum(1 for p in staff if p["unitId"] == u["id"])
        print(f"  [{u['id']}] {u['name']:<10} {n:>3} 人  {u['address']}")


if __name__ == "__main__":
    main()
