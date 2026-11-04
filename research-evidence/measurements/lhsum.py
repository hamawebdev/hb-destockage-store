import json,sys,glob,os
for f in sorted(glob.glob(sys.argv[1]+'/*.json')):
    try: d=json.load(open(f))
    except Exception as e: print(os.path.basename(f),'ERR');continue
    a=d['audits'];it=a['network-requests']['details']['items']
    by={}
    for i in it: t=i.get('resourceType','?'); by[t]=by.get(t,0)+i.get('transferSize',0)
    p=d['categories']['performance']['score']
    print('%-24s %s %s perf=%s FCP=%5.0f LCP=%5.0f TBT=%4.0f CLS=%.3f SI=%5.0f TTFB=%s tot=%.1fKB %s url=%s'%(os.path.basename(f)[:-5],d['fetchTime'][11:16],d['lighthouseVersion'],round(p*100) if p is not None else None,a['first-contentful-paint']['numericValue'],a['largest-contentful-paint']['numericValue'],a['total-blocking-time']['numericValue'],a['cumulative-layout-shift']['numericValue'],a['speed-index']['numericValue'],round(a.get('server-response-time',{}).get('numericValue') or 0),sum(by.values())/1024,{k:round(v/1024,1) for k,v in by.items()},d['finalDisplayedUrl'] if 'finalDisplayedUrl' in d else d.get('finalUrl')))
