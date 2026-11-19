#!/usr/bin/env python3
"""スキャンした文書を模した試験用 PDF（test/fixtures/scan.pdf）を作る。
ページ全体が 1 枚の画像で、文字のデータは無い。画像の形式をページごとに変えてある。
  1 ページ目：白黒 2 値・ファクス形式（CCITT G4）    … 複合機の白黒スキャンに多い
  2 ページ目：グレー・JPEG 2000（JPXDecode）
  3 ページ目：グレー・JPEG（DCTDecode）、ページは /Rotate 90
どのページも、上のほうに横線の列、中ほどに黒い帯（「消したい所」）がある。
使い方: python3 test/make-scan-fixtures.py   （Pillow に libtiff と OpenJPEG が要る）
"""
import io
import os
from PIL import Image, ImageDraw

W, H = 620, 877  # A4 を 75 dpi 相当（試験用に小さく）
OUT = os.path.join(os.path.dirname(__file__), "fixtures", "scan.pdf")


def picture(mode):
    white = 1 if mode == "1" else 255
    im = Image.new(mode, (W, H), white)
    d = ImageDraw.Draw(im)
    for i in range(12):
        d.rectangle([60, 60 + i * 24, 560, 68 + i * 24], fill=0)
    d.rectangle([100, 400, 300, 450], fill=0)  # 消したい所
    d.rectangle([340, 400, 540, 450], fill=0)  # 残したい所
    for i in range(10):
        d.rectangle([60, 560 + i * 24, 560, 568 + i * 24], fill=0)
    return im


def ccitt():
    buf = io.BytesIO()
    picture("1").save(buf, format="TIFF", compression="group4", tiffinfo={278: H})  # 278 = RowsPerStrip：全体を 1 ストリップにする
    buf.seek(0)
    im = Image.open(buf)
    offs, counts = im.tag_v2[273], im.tag_v2[279]
    assert len(offs) == 1, "1 ストリップで書き出されている前提"
    data = buf.getvalue()[offs[0] : offs[0] + counts[0]]
    head = f"/Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {W} /Rows {H} /BlackIs1 true >>"
    return head, data


def jpx():
    buf = io.BytesIO()
    picture("L").save(buf, format="JPEG2000")
    return f"/Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode", buf.getvalue()


def jpeg():
    buf = io.BytesIO()
    picture("L").save(buf, format="JPEG", quality=85)
    return f"/Type /XObject /Subtype /Image /Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", buf.getvalue()


def main():
    PW, PH = 595.28, 841.89
    objs = []  # (番号, バイト列)

    def add(body):
        objs.append(body)
        return len(objs)

    add(b"")  # 1: catalog（後で入れる）
    add(b"")  # 2: pages
    kids = []
    for i, (head, data) in enumerate([ccitt(), jpx(), jpeg()]):
        img = add(f"<< {head} /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream")
        content = f"q {PW} 0 0 {PH} 0 0 cm /Im0 Do Q\n".encode()
        cs = add(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream")
        rot = " /Rotate 90" if i == 2 else ""
        kids.append(add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PW} {PH}]{rot} /Resources << /XObject << /Im0 {img} 0 R >> >> /Contents {cs} 0 R >>".encode()))
    objs[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{k} 0 R' for k in kids)}] /Count {len(kids)} >>".encode()
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for n, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for o in offsets:
        out += f"{o:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    with open(OUT, "wb") as f:
        f.write(out)
    print(OUT, len(out), "bytes")


if __name__ == "__main__":
    main()
