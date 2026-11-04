import json,sys,urllib.request,urllib.parse
geo=sys.argv[1]
for t in sys.argv[2].split('|'):
    u="https://cdn.httparchive.org/v1/cwv-distribution?"+urllib.parse.urlencode({'technology':t,'date':'2026-09-01','geo':geo})
    d=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'curl/8'}),timeout=90))
    m=[r for r in d if r['client']=='mobile']
    out=[]
    for metric in ['ttfb','fcp','lcp']:
        tot=sum(r[metric+'_origins'] for r in m)
        if not tot: continue
        def le(x): return sum(r[metric+'_origins'] for r in m if r['loading_bucket']<x)
        # bucket b covers [b, b+100)
        cum=0; med=None
        for r in sorted(m,key=lambda r:r['loading_bucket']):
            cum+=r[metric+'_origins']
            if med is None and cum>=tot/2: med=r['loading_bucket']
        out.append(f"{metric.upper()}: n={tot} p75<400ms={100*le(400)/tot:.1f}% <800={100*le(800)/tot:.1f}% <1000={100*le(1000)/tot:.1f}% <1800={100*le(1800)/tot:.1f}% <2500={100*le(2500)/tot:.1f}% median-origin-p75~{med}ms")
    print(geo,t); [print('  ',o) for o in out]
