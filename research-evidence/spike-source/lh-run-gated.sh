#!/bin/bash
# usage: lh-run-gated.sh OUTDIR TAG URL N [extra flags]; waits (max 240s) for 1-min load < 4 before each run; logs load
OUT=$1; TAG=$2; U=$3; N=$4; shift 4; mkdir -p "$OUT"
for i in $(seq 1 $N); do
  for w in $(seq 1 48); do l=$(cut -d' ' -f1 /proc/loadavg); awk -v l=$l 'BEGIN{exit !(l<4)}' && break; sleep 5; done
  echo "$TAG-$i load_before=$(cut -d' ' -f1 /proc/loadavg)" >> "$OUT/loadlog.txt"
  npx --yes lighthouse@13.6.0 "$U" --quiet --output=json --output-path="$OUT/$TAG-$i.json" --only-categories=performance,accessibility \
    --chrome-flags="--headless=new --no-sandbox --disable-gpu" "$@" >/dev/null 2>>"$OUT/errors.txt" || echo "fail $TAG $i" >> "$OUT/errors.txt"
done
