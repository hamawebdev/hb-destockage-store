#!/bin/bash
# usage: lh-run.sh TAG URL N [extra lighthouse flags...]
TAG=$1; U=$2; N=$3; shift 3
for i in $(seq 1 $N); do
  npx --yes lighthouse@13.6.0 "$U" --quiet --output=json --output-path="results/lh/$TAG-$i.json" --only-categories=performance,accessibility \
    --chrome-flags="--headless=new --no-sandbox --disable-gpu" "$@" >/dev/null 2>>results/lh/errors.txt || echo "fail $TAG $i" >> results/lh/errors.txt
done
