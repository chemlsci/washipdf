#!/usr/bin/env python3
"""暗号化された PDF のフィクスチャを pypdf で生成する（他実装との相互運用性の確認用）。

    python3 -I test/make-encrypted-fixtures.py

pypdf と cryptography が必要。生成物は test/fixtures/enc-*.pdf にコミットしてあるので、
通常の開発・CI で実行する必要はない。
"""
import os
import sys

from pypdf import PdfReader, PdfWriter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "fixtures", "ja-subset-identity.pdf")
OUT = os.path.join(HERE, "fixtures")

# 権限ビット（PDF 32000-1 表 22）。基準値 0xFFFFF0C0 は「何も許可しない」
NONE = 0xFFFFF0C0
PRINT = 4
MODIFY = 8
COPY = 16
ANNOTATE = 32
FILL = 256
ACCESS = 512
ASSEMBLE = 1024
PRINT_HQ = 2048


def signed(v: int) -> int:
    return v - (1 << 32) if v & 0x80000000 else v


def make(name: str, user: str, owner: str, algorithm: str, perms: int) -> None:
    reader = PdfReader(SRC)
    writer = PdfWriter(clone_from=reader)
    writer.encrypt(user_password=user, owner_password=owner, algorithm=algorithm, permissions_flag=signed(perms))
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        writer.write(f)
    print("wrote", path, os.path.getsize(path), "bytes")


ALL = NONE | PRINT | MODIFY | COPY | ANNOTATE | FILL | ACCESS | ASSEMBLE | PRINT_HQ

make("enc-rc4-40.pdf", "user", "owner", "RC4-40", ALL)
make("enc-rc4-128.pdf", "user", "owner", "RC4-128", ALL)
make("enc-aes-128.pdf", "user", "owner", "AES-128", ALL)
make("enc-aes-256.pdf", "user", "owner", "AES-256", ALL)
# ユーザーパスワード無し（誰でも開けるが印刷・変更は不可）。実務で最も多い形
make("enc-owner-only.pdf", "", "owner", "AES-256", NONE | COPY | ACCESS)
sys.exit(0)
