#!/usr/bin/env python3
"""Build the HB Destockage logo SVGs as outlined paths (no font needed to render them).

Reproducible: downloads Inter (SIL OFL 1.1) at a pinned commit, checks its sha256, instances
the weights used, converts glyphs to SVG paths and writes brand/logo/*.svg.

    python3 -I brand/scripts/build-logo.py [--font /path/to/Inter[opsz,wght].ttf]

Requires: fontTools (4.46+). Python is a one-off asset tool here, not part of any runtime.
The OFL allows embedding outlines of the font in artwork such as a logo.
"""
import argparse
import hashlib
import io
import os
import sys
import urllib.request

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONT_URL = "https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf"
# sha256 of the file the committed SVGs were built from (google/fonts main, fetched 2026-11-04).
# If upstream changes, the build still runs but warns: compare the output before committing.
FONT_SHA256 = "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "logo"))

# Brand colours (brand/tokens.json)
TEXT = "#1d1d1f"
ACCENT = "#0071e3"
INVERSE_TEXT = "#f5f5f7"
INVERSE_ACCENT = "#2997ff"
WHITE = "#ffffff"

# ---- Design parameters (font units: Inter UPM = 2048) -------------------------------------
HB_WGHT = 700          # "HB": bold initials
WORD_WGHT = 400        # "DESTOCKAGE": regular, tracked
OPSZ = 32              # display optical size: tighter spacing, finer details
WORD_TRACK = 0.06      # tracking for DESTOCKAGE, in em
HB_TRACK = -0.01       # HB slightly tightened
DOT_GAP = 0.20         # space HB -> dot -> DESTOCKAGE, in em (each side)
DOT_R = 0.085          # accent dot radius, in em (sits on the cap-height middle)
# Optical pair kerning for the tracked caps, in em (added to tracking). Hand-tuned by eye.
KERN = {("T", "O"): -0.03, ("C", "K"): 0.0, ("K", "A"): -0.035, ("A", "G"): -0.01, ("S", "T"): -0.01}
PRECISION = 1          # decimals in output coordinates (viewBox scaled so 1 unit ~ 1/100 cap)


def get_font(path):
    if path:
        data = open(path, "rb").read()
    else:
        data = urllib.request.urlopen(FONT_URL, timeout=60).read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != FONT_SHA256:
        print(f"WARNING: Inter sha256 {digest} != pinned {FONT_SHA256}", file=sys.stderr)
    return data


def instance(data, wght):
    f = TTFont(io.BytesIO(data))
    return instancer.instantiateVariableFont(f, {"wght": wght, "opsz": OPSZ}, inplace=False)


class Setter:
    """Lays out glyphs left to right; collects one SVG path string per glyph."""

    def __init__(self, scale):
        self.scale = scale  # output units per font unit
        self.x = 0.0
        self.paths = []

    def glyph(self, font, ch, track_em=0.0):
        gs = font.getGlyphSet()
        name = font.getBestCmap()[ord(ch)]
        upm = font["head"].unitsPerEm
        pen = SVGPathPen(gs, ntos=lambda v: fmt(v))
        s = self.scale
        # flip y: font y-up -> svg y-down, baseline at y = 0
        tpen = TransformPen(pen, (s, 0, 0, -s, self.x, 0))
        gs[name].draw(tpen)
        self.paths.append(pen.getCommands())
        self.x += (gs[name].width + track_em * upm) * s
        return name


def fmt(v):
    r = round(v, PRECISION)
    if r == int(r):
        return str(int(r))
    s = f"{r:.{PRECISION}f}".rstrip("0")
    return s.replace("0.", ".", 1) if s.startswith("0.") else s.replace("-0.", "-.", 1)


def cap_height(font):
    return font["OS/2"].sCapHeight


def bounds_of(font, text):
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    bp = BoundsPen(gs)
    x = 0
    for ch in text:
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(bp, (1, 0, 0, 1, x, 0)))
        x += g.width
    return bp.bounds


def build_wordmark(hb, word):
    upm = hb["head"].unitsPerEm
    cap = cap_height(hb)
    # Output scale: cap height = 100 units.
    s = 100.0 / cap
    st = Setter(s)
    # left side bearing of H trimmed so the mark starts at x = 0
    lsb = hb["hmtx"]["H"][1] * s
    st.x = -lsb
    for i, ch in enumerate("HB"):
        st.glyph(hb, ch, HB_TRACK if i == 0 else 0)
    # remove B's right side bearing, then the gap + dot + gap
    gs = hb.getGlyphSet()
    bp = BoundsPen(gs)
    gs["B"].draw(bp)
    b_right_bearing = (gs["B"].width - bp.bounds[2]) * s
    st.x -= b_right_bearing
    gap = DOT_GAP * upm * s
    r = DOT_R * upm * s
    st.x += gap
    dot_cx = st.x + r
    dot_cy = -50.0  # middle of cap height
    st.x += 2 * r + gap
    # DESTOCKAGE
    wgs = word.getGlyphSet()
    d_lsb = word["hmtx"]["D"][1] * s
    st.x -= d_lsb
    text = "DESTOCKAGE"
    for i, ch in enumerate(text):
        nxt = text[i + 1] if i + 1 < len(text) else None
        k = KERN.get((ch, nxt), 0.0) if nxt else 0.0
        st.glyph(word, ch, (WORD_TRACK + k) if nxt else 0.0)
    bp = BoundsPen(wgs)
    wgs["E"].draw(bp)
    e_rb = (wgs["E"].width - bp.bounds[2]) * s
    width = st.x - e_rb
    return st.paths, (dot_cx, dot_cy, r), width


def build_monogram(hb):
    cap = cap_height(hb)
    size = 64.0
    # "HB" cap height = 36% of the tile
    s = (size * 0.36) / cap
    st = Setter(s)
    st.glyph(hb, "H", HB_TRACK)
    st.glyph(hb, "B")
    paths = st.paths
    # measure ink bounds to centre
    gs = hb.getGlyphSet()
    bp = BoundsPen(gs)
    gs["H"].draw(bp)
    h_l = bp.bounds[0]
    bp2 = BoundsPen(gs)
    gs["B"].draw(TransformPen(bp2, (1, 0, 0, 1, gs["H"].width + HB_TRACK * hb["head"].unitsPerEm, 0)))
    ink_l = h_l * s
    ink_r = bp2.bounds[2] * s
    ink_w = ink_r - ink_l
    tx = (size - ink_w) / 2 - ink_l
    ty = size / 2 + (cap * s) / 2  # baseline so caps are vertically centred
    return paths, tx, ty, size


def join(paths):
    return "".join(paths)


def write(name, svg):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as fh:
        fh.write(svg)
    print("wrote", os.path.join("brand/logo", name), len(svg.encode()), "bytes", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--font")
    args = ap.parse_args()
    data = get_font(args.font)
    hb = instance(data, HB_WGHT)
    word = instance(data, WORD_WGHT)

    paths, (cx, cy, r), width = build_wordmark(hb, word)
    hb_d = join(paths[:2])
    word_d = join(paths[2:])
    # viewBox: x 0..width, y -100..0 (cap height) — no descenders in caps
    vb = f"0 -100 {fmt(width)} 100"
    title = "<title>HB Destockage</title>"

    def wordmark(text_fill, dot_fill, with_title=True, extra=""):
        t = title if with_title else ""
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"{extra}>{t}'
            f'<path fill="{text_fill}" d="{hb_d}{word_d}"/>'
            f'<circle fill="{dot_fill}" cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r)}"/></svg>\n'
        )

    write("wordmark.svg", wordmark(TEXT, ACCENT, extra=' role="img" aria-label="HB Destockage"'))
    write("wordmark-inverse.svg", wordmark(INVERSE_TEXT, INVERSE_ACCENT, extra=' role="img" aria-label="HB Destockage"'))
    write("wordmark-mono.svg", wordmark("currentColor", "currentColor", extra=' role="img" aria-label="HB Destockage"'))
    # Header version: integer coordinates (1 unit = 1 % of cap height = 0.18 px at an 18 px header
    # cap — invisible) to keep the inline bytes down.
    global PRECISION
    keep = PRECISION
    PRECISION = 0
    hpaths, (hcx, hcy, hr), _ = build_wordmark(hb, word)
    hd = join(hpaths)
    PRECISION = keep
    # Inline in the storefront header. Letters follow currentColor (text token),
    # dot uses the accent custom property with a hex fallback. aria handled by the <a> around it.
    write(
        "wordmark-header.svg",
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" aria-hidden="true" focusable="false">'
        f'<path fill="currentColor" d="{hd}"/>'
        f'<circle fill="var(--color-accent,{ACCENT})" cx="{fmt(hcx)}" cy="{fmt(hcy)}" r="{fmt(hr)}"/></svg>\n',
    )

    mp, tx, ty, size = build_monogram(hb)
    md = join(mp)
    rad = 14  # tile corner radius (22% of 64, app-icon-like)
    dot_r = 4
    # tag eyelet: top inline-end corner (top-right; logo never mirrors)
    dcx, dcy = size - 12, 12

    def monogram(tile, letters, dot, with_title=True):
        t = title if with_title else ""
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {int(size)} {int(size)}" role="img" aria-label="HB Destockage">{t}'
            f'<rect width="{int(size)}" height="{int(size)}" rx="{rad}" fill="{tile}"/>'
            f'<path fill="{letters}" transform="translate({fmt(tx)} {fmt(ty)})" d="{md}"/>'
            f'<circle fill="{dot}" cx="{dcx}" cy="{dcy}" r="{dot_r}"/></svg>\n'
        )

    write("monogram.svg", monogram(TEXT, WHITE, ACCENT))
    write("monogram-inverse.svg", monogram(WHITE, TEXT, ACCENT))
    write("monogram-accent.svg", monogram(ACCENT, WHITE, WHITE))
    # mono: tile in currentColor, letters + dot knocked out (transparent) via mask
    write(
        "monogram-mono.svg",
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {int(size)} {int(size)}" role="img" aria-label="HB Destockage">{title}'
        f'<mask id="k"><rect width="{int(size)}" height="{int(size)}" fill="#fff"/>'
        f'<path fill="#000" transform="translate({fmt(tx)} {fmt(ty)})" d="{md}"/>'
        f'<circle fill="#000" cx="{dcx}" cy="{dcy}" r="{dot_r}"/></mask>'
        f'<rect width="{int(size)}" height="{int(size)}" rx="{rad}" fill="currentColor" mask="url(#k)"/></svg>\n',
    )

    # Lockup: monogram tile + wordmark, for the guide, social images and print.
    # Tile height = 1.6 × cap height of the wordmark; gap = 0.5 × tile.
    tile_h = 160.0
    k = tile_h / size
    gap = tile_h * 0.35
    lw = tile_h + gap + width
    lock = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {fmt(lw)} {fmt(tile_h)}" role="img" aria-label="HB Destockage">{title}'
        f'<g transform="scale({fmt(k)})">'
        f'<rect width="{int(size)}" height="{int(size)}" rx="{rad}" fill="{TEXT}"/>'
        f'<path fill="{WHITE}" transform="translate({fmt(tx)} {fmt(ty)})" d="{md}"/>'
        f'<circle fill="{ACCENT}" cx="{dcx}" cy="{dcy}" r="{dot_r}"/></g>'
        f'<g transform="translate({fmt(tile_h + gap)} {fmt(tile_h / 2 + 50)})">'
        f'<path fill="{TEXT}" d="{hb_d}{word_d}"/>'
        f'<circle fill="{ACCENT}" cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r)}"/></g></svg>\n'
    )
    write("lockup.svg", lock)


if __name__ == "__main__":
    main()
