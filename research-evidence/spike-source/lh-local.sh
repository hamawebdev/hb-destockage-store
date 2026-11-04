#!/bin/bash
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
L=http://127.0.0.1:8790; O=results/lh-local
for p in ar ar-sys; do ./lh-run-gated.sh $O "L-$p" "$L/$p/" 5; done
for p in fr ar; do ./lh-run-gated.sh $O "LB80-$p" "$L/$p/" 3 --throttling.rttMs=80 --throttling.throughputKbps=10000 --throttling.cpuSlowdownMultiplier=4; ./lh-run-gated.sh $O "LB150-$p" "$L/$p/" 3 --throttling.rttMs=150 --throttling.throughputKbps=4000 --throttling.cpuSlowdownMultiplier=4; done
echo DONE > $O/DONE
