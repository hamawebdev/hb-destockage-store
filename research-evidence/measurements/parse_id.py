import json,base64,datetime,sys,statistics,collections
def txt(ab):
    raw=base64.b64decode(ab)
    # last TXT rdata: find last length-prefixed string
    # crude: rdata at end: rdlen(2) txtlen(1) str
    for L in range(1,20):
        if len(raw)>L and raw[-L-1]==L:
            s=raw[-L:]
            if all(32<c<127 for c in s): return s.decode()
    return '?'
d=json.load(open(sys.argv[1]))
rows=[]
for r in d:
    res=r.get('result')
    if not res: 
        rows.append((r['timestamp'],r['prb_id'],None,'ERR'));continue
    rows.append((r['timestamp'],r['prb_id'],res.get('rt'),txt(res['abuf']) if res.get('abuf') else '?'))
rows.sort()
bymonth=collections.defaultdict(list)
for t,p,rt,c in rows:
    m=datetime.datetime.fromtimestamp(t,datetime.UTC).strftime('%Y-%m')
    bymonth[(p,m)].append((rt,c))
for k in sorted(bymonth):
    v=bymonth[k]; rts=[x for x,_ in v if x]
    print(k, len(v), 'median_rt', round(statistics.median(rts),1) if rts else None, 'min',round(min(rts),1) if rts else None, collections.Counter(c for _,c in v))
