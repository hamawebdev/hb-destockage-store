#!/bin/bash
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
N=laced-racer; O=results/lh-real
REAL="--throttling-method=devtools --throttling.requestLatencyMs=0 --throttling.downloadThroughputKbps=0 --throttling.uploadThroughputKbps=0 --throttling.cpuSlowdownMultiplier=4"
./lh-run-gated.sh $O C-s1-fr https://dz-spike-s1-static.$N.workers.dev/fr/ 3 $REAL
./lh-run-gated.sh $O C-s1-ar https://dz-spike-s1-static.$N.workers.dev/ar/ 3 $REAL
./lh-run-gated.sh $O C-s3-ar https://dz-spike-s3-rust.$N.workers.dev/ar/ 2 $REAL
./lh-run-gated.sh $O D-s1-ar https://dz-spike-s1-static.$N.workers.dev/ar/ 2
for u in https://batolis.com/ https://www.ouedkniss.com/ https://condor.dz/; do t=$(echo $u | sed -E 's#https://(www\.)?##; s#[./]+#_#g'); ./lh-run-gated.sh $O "BASE-sim-$t" "$u" 2 --max-wait-for-load=60000; ./lh-run-gated.sh $O "BASE-real-$t" "$u" 1 --max-wait-for-load=60000 $REAL; done
echo DONE > $O/DONE
