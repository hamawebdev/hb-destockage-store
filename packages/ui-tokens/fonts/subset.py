#!/usr/bin/env python3
"""Reproducible Arabic font subset for the storefront (TOKENS-2).

Usage (from the repo root):  python3 -I packages/ui-tokens/fonts/subset.py [--zip PATH]

Downloads the pinned official notofonts release (or uses --zip), verifies its sha256 and the
sha256 of the static Regular (400) TTF inside it, subsets it with fontTools to the code points in
subset.json, and writes fonts/noto-sans-arabic-400.woff2 + fonts/OFL.txt. Same inputs and the
pinned fontTools/brotli versions give byte-identical output. Then run `node src/gen/cli.ts`.
Based on research-evidence/measurements/i18n-scripts/subset.sh (the STACK-REPORT measurement).
"""
import argparse
import hashlib
import io
import json
import os
import sys
import urllib.request
import zipfile

import brotli
import fontTools
from fontTools import subset
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", ".."))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_unicodes(entries) -> list[int]:
    cps: set[int] = set()
    for e in entries:
        for part in e["range"].split(","):
            part = part.strip().upper().removeprefix("U+")
            lo, _, hi = part.partition("-")
            cps.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return sorted(cps)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", help="use an already-downloaded release zip instead of fetching it")
    ap.add_argument("--allow-toolchain-drift", action="store_true", help="run with other fontTools/brotli versions (bytes may differ)")
    args = ap.parse_args()

    cfg = json.load(open(os.path.join(HERE, "subset.json"), encoding="utf-8"))
    src = cfg["source"]

    tool = {"fonttools": fontTools.version, "brotli": brotli.__version__}
    if tool != cfg["toolchain"]:
        msg = f"toolchain {tool} != pinned {cfg['toolchain']}"
        if not args.allow_toolchain_drift:
            print(f"error: {msg} (pass --allow-toolchain-drift to continue)", file=sys.stderr)
            return 1
        print(f"warning: {msg}", file=sys.stderr)

    if args.zip:
        data = open(args.zip, "rb").read()
    else:
        with urllib.request.urlopen(src["url"], timeout=120) as r:
            data = r.read()
    if sha256(data) != src["zipSha256"]:
        print(f"error: zip sha256 {sha256(data)} != pinned {src['zipSha256']}", file=sys.stderr)
        return 1

    z = zipfile.ZipFile(io.BytesIO(data))
    ttf = z.read(src["member"])  # read named members only, never extractall
    if sha256(ttf) != src["memberSha256"]:
        print(f"error: {src['member']} sha256 mismatch", file=sys.stderr)
        return 1
    ofl = z.read(src["license"])

    unicodes = parse_unicodes(cfg["unicodes"])
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.hinting = False
    opts.recalc_timestamp = False
    font = TTFont(io.BytesIO(ttf), recalcTimestamp=False)
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=unicodes)
    sub.subset(font)
    out = io.BytesIO()
    font.flavor = "woff2"
    font.save(out, reorderTables=False)
    woff2 = out.getvalue()

    cmap = set(TTFont(io.BytesIO(woff2)).getBestCmap())
    missing_algerian = [hex(c) for c in (0x06A2, 0x06A7, 0x06A8) if c not in cmap]
    if missing_algerian:
        print(f"error: Algerian letters missing: {missing_algerian}", file=sys.stderr)
        return 1
    if len(woff2) > cfg["budgetBytes"]:
        print(f"error: {len(woff2)} B > budget {cfg['budgetBytes']} B", file=sys.stderr)
        return 1

    with open(os.path.join(HERE, cfg["output"]), "wb") as f:
        f.write(woff2)
    with open(os.path.join(HERE, "OFL.txt"), "wb") as f:
        f.write(ofl)

    absent = [f"U+{c:04X}" for c in unicodes if c not in cmap]
    print(f"{cfg['output']}: {len(woff2)} B ({len(woff2) / 1024:.2f} KiB), sha256 {sha256(woff2)}")
    print(f"code points in font: {len(cmap)}; requested but absent from the source font: {len(absent)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
