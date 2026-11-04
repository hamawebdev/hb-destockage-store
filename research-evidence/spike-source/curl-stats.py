import sys,collections
def q(v,p):
    v=sorted(v); 
    if not v: return float('nan')
    k=(len(v)-1)*p; f=int(k); c=min(f+1,len(v)-1); return v[f]+(v[c]-v[f])*(k-f)
rows=collections.defaultdict(list); colos=collections.defaultdict(collections.Counter); st=collections.defaultdict(collections.Counter)
for l in open(sys.argv[1]):
    p=l.rstrip('\n').split('\t')
    if len(p)<13: continue
    mode,tag,i,hv,code,dns,tcp,tls,ttfb,tot,size,nc,ray,xs,cs=p[:15] if len(p)>=15 else p+['']*(15-len(p))
    if mode=='warm' and i=='0': continue
    d=dict(dns=float(dns),tcp=float(tcp),tls=float(tls),ttfb=float(ttfb),total=float(tot))
    if mode=='cold':
        d['tcp_only']=d['tcp']-d['dns']; d['tls_only']=d['tls']-d['tcp']; d['srv']=d['ttfb']-d['tls']
    rows[(mode,tag)].append(d); colos[(mode,tag)][ray.split('-')[-1] if ray else '?']+=1; st[(mode,tag)][code+('/'+xs if xs else '')]+=1
for k,v in rows.items():
    keys=['dns','tcp_only','tls_only','srv','ttfb','total'] if k[0]=='cold' else ['ttfb','total']
    s=' '.join(f"{m}={q([x[m] for x in v],.5)*1000:.0f}/{q([x[m] for x in v],.75)*1000:.0f}/{q([x[m] for x in v],.9)*1000:.0f}" for m in keys)
    under=sum(1 for x in v if x['total']<0.4)/len(v)
    stalls=sum(1 for x in v if x['total']>3)
    print(f"{k[0]:4} {k[1]:16} n={len(v):2} {s}  <400ms={under:.0%} >3s={stalls} colo={dict(colos[k])} st={dict(st[k])}")
