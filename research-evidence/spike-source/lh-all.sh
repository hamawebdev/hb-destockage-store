#!/bin/bash
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
S1=https://dz-spike-s1-static.thankful-servant.workers.dev; S2=https://dz-spike-s2-hono.thankful-servant.workers.dev; S3=https://dz-spike-s3-rust.thankful-servant.workers.dev
REAL="--throttling-method=devtools --throttling.requestLatencyMs=0 --throttling.downloadThroughputKbps=0 --throttling.uploadThroughputKbps=0 --throttling.cpuSlowdownMultiplier=4"
# A: default mobile simulated
for t in "s1-fr $S1/fr/" "s1-ar $S1/ar/" "s1-arsys $S1/ar-sys/" "s2-fr $S2/fr/" "s2-ar $S2/ar/" "s3-fr $S3/fr/" "s3-ar $S3/ar/"; do set -- $t; ./lh-run.sh "A-$1" "$2" 3; done
# C: real Djezzy 4G network from Setif, CPU x4 (devtools)
for t in "s1-fr $S1/fr/" "s1-ar $S1/ar/" "s2-ar $S2/ar/" "s3-ar $S3/ar/"; do set -- $t; ./lh-run.sh "C-$1" "$2" 3 $REAL; done
# B: custom simulated approximations
for t in "s1-fr $S1/fr/" "s1-ar $S1/ar/"; do set -- $t; ./lh-run.sh "B80-$1" "$2" 3 --throttling.rttMs=80 --throttling.throughputKbps=10000 --throttling.cpuSlowdownMultiplier=4; ./lh-run.sh "B150-$1" "$2" 3 --throttling.rttMs=150 --throttling.throughputKbps=4000 --throttling.cpuSlowdownMultiplier=4; done
echo DONE > results/lh/DONE
