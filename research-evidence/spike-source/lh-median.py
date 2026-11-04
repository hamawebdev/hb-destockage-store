import json,sys,collections,statistics as S,subprocess,re
out=subprocess.run([sys.executable,'-I',sys.argv[1]]+sys.argv[2:],capture_output=True,text=True).stdout
g=collections.defaultdict(list)
for l in out.splitlines():
    d=json.loads(l); 
    if d.get('rterr') or d.get('score') is None: print('ERR',d['file'],d.get('rterr')); continue
    g[re.sub(r'-\d+\.json$','',d['file'])].append(d)
for k,v in g.items():
    m=lambda f: S.median([x[f] for x in v if x.get(f) is not None])
    print(f"{k:28} n={len(v)} score={[x['score'] for x in v]} med: score={m('score'):.0f} fcp={m('fcp'):.0f} lcp={m('lcp'):.0f} tbt={m('tbt'):.0f} cls={m('cls')} si={m('si'):.0f} ttfb={m('ttfb'):.0f} KB={m('bytes')/1024:.1f} req={m('n_req'):.0f} bench={m('bench'):.0f} a11y={m('a11y'):.0f}")
