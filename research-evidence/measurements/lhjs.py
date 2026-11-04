import json,sys
for f in sys.argv[1:]:
    d=json.load(open(f));a=d['audits']
    items=a['network-requests']['details']['items']
    by={}
    for it in items:
        t=it.get('resourceType','?'); by[t]=by.get(t,0)+it.get('transferSize',0)
    bt=a.get('bootup-time',{}).get('numericValue')
    print(f.split('/')[-1], 'perf',round(d['categories']['performance']['score']*100),'LCP',a['largest-contentful-paint']['displayValue'],'TBT',a['total-blocking-time']['displayValue'], 'transfer by type', {k:v for k,v in by.items()}, 'js-bootup-ms',round(bt or 0))
