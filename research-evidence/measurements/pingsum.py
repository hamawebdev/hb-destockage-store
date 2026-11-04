import json,sys,datetime,statistics,collections,urllib.request
mid=sys.argv[1]; start=int(sys.argv[2])
url=f"https://atlas.ripe.net/api/v2/measurements/{mid}/results/?probe_ids=1001421&start={start}&format=json"
d=json.load(urllib.request.urlopen(url,timeout=180))
bym=collections.defaultdict(list); dst=set()
for r in d:
    m=datetime.datetime.fromtimestamp(r['timestamp'],datetime.UTC).strftime('%Y-%m')
    dst.add(r.get('dst_addr'))
    if r.get('min',-1)>0: bym[m].append(r['min'])
print(mid, 'n=',len(d), 'dst', dst)
for m in sorted(bym):
    v=sorted(bym[m]); print(' ',m,'n',len(v),'p10',round(v[len(v)//10],1),'median',round(statistics.median(v),1),'p90',round(v[int(len(v)*.9)],1))
