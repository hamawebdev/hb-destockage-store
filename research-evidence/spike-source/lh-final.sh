#!/bin/bash
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
N=laced-racer; O=results/lh-final
for s in s1-static s2-hono s3-rust; do for p in fr ar; do ./lh-run-gated.sh $O "A-$s-$p" "https://dz-spike-$s.$N.workers.dev/$p/" 3; done; done
echo DONE > $O/DONE
