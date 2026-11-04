import json,sys,datetime,collections,urllib.request
mid=sys.argv[1]
url=f"https://atlas.ripe.net/api/v2/measurements/{mid}/results/?probe_ids=1001421&start=1788220800&stop=1793491200&format=json"
d=json.load(urllib.request.urlopen(url,timeout=180))
json.dump(d,open(f'ping_{mid}_sepoct.json','w'))
h=collections.defaultdict(lambda:[0,0])
for r in d:
    if r.get('min',-1)<=0: continue
    hr=(datetime.datetime.fromtimestamp(r['timestamp'],datetime.UTC).hour+1)%24  # Algeria UTC+1
    h[hr][0]+=1; h[hr][1]+= r['min']>30
print(mid,'local hour: frac>30ms (Sep-Oct 2026)')
print(' '.join(f"{k:02d}:{v[1]/v[0]:.2f}" for k,v in sorted(h.items())))
