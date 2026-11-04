import json,sys,datetime,collections,urllib.request
for mid in sys.argv[1:]:
    url=f"https://atlas.ripe.net/api/v2/measurements/{mid}/results/?probe_ids=1001421&start=1790812800&stop=1793491200&format=json"
    d=json.load(urllib.request.urlopen(url,timeout=180))
    v=[r['min'] for r in d if r.get('min',-1)>0]
    allrtt=[x['rtt'] for r in d for x in r.get('result',[]) if 'rtt' in x]
    b=collections.Counter(int(x//5)*5 for x in v)
    print(mid,'Oct2026 n',len(v),'buckets(min rtt ms)',sorted(b.items()), 'frac>30', round(sum(1 for x in v if x>30)/len(v),3), 'loss', round(1-len(allrtt)/max(1,sum(r.get('sent',0) for r in d)),4))
