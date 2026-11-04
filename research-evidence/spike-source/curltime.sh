#!/bin/bash
# usage: curltime.sh URL N  -> one fresh TCP+TLS connection per run
U=$1; N=${2:-10}; H=$(mktemp)
for i in $(seq 1 $N); do
  curl -s -o /dev/null -H 'accept-encoding: br, gzip' -D "$H" \
   -w "%{http_version} dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} size=%{size_download}" "$U"
  echo " colo=$(grep -i cf-ray "$H" | tr -d '\r' | awk -F- '{print $NF}') cache=$(grep -i -E 'cf-cache-status|x-s2-cache' "$H" | tr -d '\r' | awk '{print $2}' | tr '\n' ,)"
done; rm -f "$H"
