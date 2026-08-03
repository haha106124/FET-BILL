#!/usr/bin/env python3
"""Encrypt a local directory before it is placed in the hosted PWA.

The original spreadsheet and the readable JSON directory must remain local.
Only the AES-GCM encrypted envelope is safe to commit to the repository.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ROOT = Path(__file__).resolve().parent.parent
ITERATIONS = 310_000
KEY_LEN = 32
SALT_LEN = 16
IV_LEN = 12


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode('ascii')


def derive_key(account: str, password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        'sha256', f'{account}:{password}'.encode('utf-8'), salt, ITERATIONS, KEY_LEN
    )


def main() -> int:
    parser = argparse.ArgumentParser(description='Encrypt a local phonebook directory.')
    parser.add_argument('--account', required=True, help='The app sign-in name')
    parser.add_argument('--password', help='Avoid this option: command history can expose it.')
    parser.add_argument('--input', type=Path, required=True, help='Local readable directory.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'data' / 'directory.enc.json')
    args = parser.parse_args()

    password = args.password or os.environ.get('FET_SCANNER_PASSWORD')
    if not password:
        password = getpass.getpass('Scanner password: ')
    if not password:
        raise SystemExit('A password is required.')
    if not args.input.exists():
        raise SystemExit(f'Input file not found: {args.input}')

    raw = args.input.read_bytes()
    directory = json.loads(raw)
    if not isinstance(directory.get('people'), list) or not isinstance(directory.get('units'), list):
        raise SystemExit('Input file is not a valid directory.')

    salt = os.urandom(SALT_LEN)
    iv = os.urandom(IV_LEN)
    key = derive_key(args.account, password, salt)
    ciphertext = AESGCM(key).encrypt(iv, raw, None)
    envelope = {
        'v': 1,
        'kdf': 'PBKDF2-SHA256',
        'iterations': ITERATIONS,
        'salt': b64(salt),
        'iv': b64(iv),
        'cipher': 'AES-256-GCM',
        'data': b64(ciphertext),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(envelope, indent=1), encoding='utf-8')
    print(f'Encrypted {len(directory["people"])} entries and {len(directory["units"])} sites.')
    print(f'Created: {args.output}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
