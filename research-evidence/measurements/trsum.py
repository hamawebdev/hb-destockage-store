import json,sys,datetime,collections,urllib.request
mid=sys.argv[1]; start=int(sys.argv[2])
url=f"https://atlas.ripe.net/api/v2/measurements/{mid}/results/?probe_ids=1001421&start={start}&format=json"
d=json.load(urllib.request.urlopen(url,timeout=180)); d.sort(key=lambda r:r['timestamp'])
print(mid,len(d))
paths=collections.Counter(); last=collections.defaultdict(list)
for r in d:
    hops=[]
    for h in r['result']:
        f=[x.get('from') for x in h.get('result',[]) if x.get('from')]
        hops.append(f[0] if f else '*')
    paths[tuple(hops[4:])]+=1
    rt=[x['rtt'] for x in r['result'][-1].get('result',[]) if 'rtt' in x]
    if rt: last[datetime.datetime.fromtimestamp(r['timestamp'],datetime.UTC).strftime('%Y-%m')].append(min(rt))
for p,c in paths.most_common(6): print(c,p)
import statistics
for m in sorted(last): print(m, len(last[m]), round(statistics.median(last[m]),1))
for r in d[-1:]:
  for h in r['result']:
    print(h['hop'], [(x.get('from'),x.get('rtt')) for x in h.get('result',[])][:2])
