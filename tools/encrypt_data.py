#!/usr/bin/env python3
"""把名冊加密成網站用的 data/directory.enc.json。

網站放在公開的 GitHub Pages 上，任何人都能下載到資料檔，所以名冊不能用明文放。
這支程式用「帳號 + 密碼」推導金鑰，把整份名冊加密；瀏覽器端輸入正確的帳密才解得開。

  金鑰推導：PBKDF2-HMAC-SHA256，310,000 次，32 bytes
  加密：AES-256-GCM（GCM 的驗證標籤順便擋掉錯誤的帳密與竄改）

帳號密碼只在執行時傳入，不會寫進任何檔案，也不會進 git。

用法：
    pip install cryptography
    python3 tools/encrypt_data.py --account fe109159 --password '你的密碼'

改密碼就是換參數重跑一次，然後 commit 新的 data/directory.enc.json。
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "data" / "directory.json"
DEFAULT_OUT = ROOT / "data" / "directory.enc.json"

ITERATIONS = 310_000
KEY_LEN = 32
SALT_LEN = 16
IV_LEN = 12


def derive_key(account: str, password: str, salt: bytes) -> bytes:
    """帳號與密碼一起當作密鑰材料，兩個都對才推得出同一把金鑰。"""
    secret = f"{account}:{password}".encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", secret, salt, ITERATIONS, KEY_LEN)


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def main() -> int:
    ap = argparse.ArgumentParser(description="加密名冊供公開網站使用")
    ap.add_argument("--account", help="登入帳號")
    ap.add_argument("--password", help="登入密碼（省略則互動輸入，比較不會留在 shell 紀錄裡）")
    ap.add_argument("--input", type=Path, default=DEFAULT_IN)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUT)
    args = ap.parse_args()

    account = args.account or input("帳號：").strip()
    password = args.password or getpass.getpass("密碼：")
    if not account or not password:
        print("帳號與密碼都不能空白", file=sys.stderr)
        return 1

    if not args.input.exists():
        print(f"找不到 {args.input}，請先執行 tools/extract_pdf.py", file=sys.stderr)
        return 1

    plaintext = args.input.read_bytes()
    directory = json.loads(plaintext)

    salt = os.urandom(SALT_LEN)
    iv = os.urandom(IV_LEN)
    key = derive_key(account, password, salt)
    # AES-GCM 產出的密文尾端已含 16 bytes 驗證標籤，WebCrypto 也是同樣的慣例
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)

    envelope = {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iterations": ITERATIONS,
        "salt": b64(salt),
        "iv": b64(iv),
        "cipher": "AES-256-GCM",
        "data": b64(ciphertext),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(envelope, indent=1), encoding="utf-8")

    print(f"已加密 {len(directory['people'])} 位人員、{len(directory['units'])} 個單位")
    print(f"  → {args.output}（{args.output.stat().st_size / 1024:.0f} KB）")
    print("\n提醒：data/directory.json 是明文，不要 commit（.gitignore 已排除）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
