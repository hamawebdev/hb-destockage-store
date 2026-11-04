import json,sys,urllib.request,statistics
for mid in sys.argv[1:]:
    url=f"https://atlas.ripe.net/api/v2/measurements/{mid}/results/?probe_ids=1001421&start=1792540800&stop=1793491200&format=json"
    d=json.load(urllib.request.urlopen(url,timeout=100))
    v=sorted(r['min'] for r in d if r.get('min',-1)>0)
    print(mid, d[0]['dst_name'] if d else '', 'n',len(v),'median',round(statistics.median(v),1) if v else None,'p10',round(v[len(v)//10],1) if v else None)
