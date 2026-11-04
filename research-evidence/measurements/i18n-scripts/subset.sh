#!/bin/bash
# usage: subset.sh fontdir outdir
set -e
F=$1; O=$2; mkdir -p $O
ARCORE="U+060C,U+061B,U+061F,U+0621-063A,U+0640-0652,U+0660-066D,U+0670,U+200C-200F,U+2066-2069,U+FD3E-FD3F"
ARFULL="U+0600-06FF,U+0750-077F,U+08A0-08FF,U+200C-200F,U+2066-2069,U+FB50-FDFF,U+FE70-FEFF"
LATFR="U+0020-007E,U+00A0-00FF,U+0152-0153,U+0178,U+02C6,U+02DC,U+2013-2014,U+2018-201E,U+2022,U+2026,U+2039-203A,U+202F,U+20AC,U+2122"
for f in $F/*.ttf; do
  b=$(basename $f .ttf)
  python3 -m fontTools.subset $f --unicodes='*' --glyphs='*' --layout-features='*' --flavor=woff2 --output-file=$O/$b.full.woff2 2>/dev/null
  python3 -m fontTools.subset $f --unicodes="$ARFULL" --flavor=woff2 --output-file=$O/$b.arfull.woff2 2>/dev/null
  python3 -m fontTools.subset $f --unicodes="$ARCORE,U+0020-0040,U+00A0" --flavor=woff2 --output-file=$O/$b.arcore.woff2 2>/dev/null
  python3 -m fontTools.subset $f --unicodes="$LATFR" --flavor=woff2 --output-file=$O/$b.latfr.woff2 2>/dev/null
  python3 -m fontTools.subset $f --unicodes="$ARCORE,$LATFR" --flavor=woff2 --output-file=$O/$b.arcore+latfr.woff2 2>/dev/null
done
