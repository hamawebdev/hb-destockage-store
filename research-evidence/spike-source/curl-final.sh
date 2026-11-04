#!/bin/bash
# cold: one curl process per request (new DNS lookup via resolver cache, new TCP+TLS); warm: one curl process, N sequential requests on one reused connection
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
N=15; B=laced-racer; OUT=results/curl-final.tsv; : > $OUT
F='%{http_version}\t%{http_code}\t%{time_namelookup}\t%{time_connect}\t%{time_appconnect}\t%{time_starttransfer}\t%{time_total}\t%{size_download}\t%{num_connects}\t%header{cf-ray}\t%header{x-s2-cache}\t%header{cf-cache-status}\n'
URLS="s1-fr|https://dz-spike-s1-static.$B.workers.dev/fr/
s1-ar|https://dz-spike-s1-static.$B.workers.dev/ar/
s2-fr|https://dz-spike-s2-hono.$B.workers.dev/fr/
s2-ar|https://dz-spike-s2-hono.$B.workers.dev/ar/
s3-fr|https://dz-spike-s3-rust.$B.workers.dev/fr/
s3-ar|https://dz-spike-s3-rust.$B.workers.dev/ar/
s2-ar-bust|https://dz-spike-s2-hono.$B.workers.dev/ar/?nocache=RND
s3-ar-bust|https://dz-spike-s3-rust.$B.workers.dev/ar/?nocache=RND
spike-trace|https://dz-spike-s1-static.$B.workers.dev/cdn-cgi/trace
alg-trace|https://one.one.one.one/cdn-cgi/trace
alg-1111|https://one.one.one.one/
alg-speed-trace|https://speed.cloudflare.com/cdn-cgi/trace
orn-radar-trace|https://radar.cloudflare.com/cdn-cgi/trace
bcn-www-trace|https://www.cloudflare.com/cdn-cgi/trace"
for mode in cold warm; do
 echo "$URLS" | while IFS='|' read tag u; do
  if [ $mode = cold ]; then
   for i in $(seq 1 $N); do uu=${u//RND/$RANDOM$RANDOM}; printf "$mode\t$tag\t$i\t" >> $OUT; curl -s -m 30 -o /dev/null -H 'accept-encoding: br, gzip' -A 'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile' -w "$F" "$uu" >> $OUT || echo "ERR" >> $OUT; done
  else
   args=(); for i in $(seq 0 $N); do args+=(-o /dev/null "${u//RND/$RANDOM$RANDOM}"); done
   curl -s -m 120 -H 'accept-encoding: br, gzip' -A 'Mozilla/5.0 (Linux; Android 14) Chrome/141 Mobile' -w "$F" "${args[@]}" | awk -v m=$mode -v t=$tag '{printf "%s\t%s\t%d\t%s\n",m,t,NR-1,$0}' >> $OUT
  fi
 done
done
echo DONE >> results/curl-final.done
