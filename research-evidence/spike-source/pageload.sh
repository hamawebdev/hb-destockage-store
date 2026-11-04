#!/bin/bash
# usage: pageload.sh BASE PAGE N  -> cold connection: HTML, then hero AVIF (+ font for /ar/) multiplexed in parallel on same H2 connection
B=$1; P=$2; N=${3:-5}
for i in $(seq 1 $N); do
  urls=("$B/$P/" "$B/assets/hero-960.avif"); [ "$P" = "ar" ] && urls+=("$B/assets/kufi-ar.woff2")
  # step 1: cold HTML; step 2: critical subresources in parallel reusing the connection (curl -Z multiplexes on h2)
  out=$(curl -s -Z --parallel-max 4 -H 'accept-encoding: br' -w "%{url_effective} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{num_connects}\n" -o /dev/null "${urls[0]}" --next -Z -o /dev/null -o /dev/null -o /dev/null "${urls[@]:1}" -w "%{url_effective} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{num_connects}\n" 2>&1)
  echo "$out" | awk -v run=$i -v p=$P '{split($1,a,"/"); n=a[length(a)]; if(n=="")n="html"; t[NR]=$5; printf "run%d %s %s tcp=%s tls=%s ttfb=%s total=%s bytes=%s newconn=%s\n",run,p,n,$2,$3,$4,$5,$6,$7}'
done
