import json,sys,urllib.request,urllib.parse
techs=sys.argv[2].split('|'); geo=sys.argv[1]
print(f"geo={geo}")
print(f"{'tech':22} {'date':10} {'mob_origins':>11} {'overall':>7} {'LCP':>5} {'CLS':>5} {'INP':>5} {'FCP':>5} {'TTFB':>5}")
for t in techs:
    u="https://cdn.httparchive.org/v1/cwv?"+urllib.parse.urlencode({'technology':t,'geo':geo,'rank':'ALL','start':'latest'})
    try: d=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'curl/8.5.0'}),timeout=60))
    except Exception as e: print(t,'ERR',e); continue
    if not d: print(t,'no data'); continue
    r=d[-1]; v={x['name']:x['mobile'] for x in r['vitals']}
    def p(n):
        m=v.get(n,{}); return f"{100*m['good_number']/m['tested']:.0f}%" if m.get('tested') else '-'
    print(f"{t:22} {r['date']:10} {v['overall']['tested']:>11} {p('overall'):>7} {p('LCP'):>5} {p('CLS'):>5} {p('INP'):>5} {p('FCP'):>5} {p('TTFB'):>5}")
