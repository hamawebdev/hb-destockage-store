#!/bin/bash
cd /tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike
for s in s1 s2 s3; do (cd $s && timeout 300 npx wrangler deploy --temporary 2>&1 | grep -v -i claim | grep -E "https://|Total Upload|Startup|rror"); done
