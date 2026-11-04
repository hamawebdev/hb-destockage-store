import json
for f in ['Algeria_ALL','Algeria_Astro','Algeria_Cloudflare','Algeria_Hugo','ALL_Astro','ALL_Shopify']:
    d=json.load(open('dist/'+f+'.json'));m=[r for r in d if r['client']=='mobile']
    o=[]
    for met in ['ttfb','fcp','lcp']:
        tot=sum(r[met+'_origins'] for r in m)
        o.append(met+' '+' '.join('<%d:%.1f%%'%(x,100*sum(r[met+'_origins'] for r in m if r['loading_bucket']<x)/tot) for x in (200,300,600,1200,1500)))
    print(f,' | '.join(o))
