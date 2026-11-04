import json,sys,glob,os
for f in sorted(glob.glob(sys.argv[1]+'/*.json')):
    try: d=json.load(open(f))
    except Exception: print(f,'bad'); continue
    m=[r for r in d if r['client']=='mobile']
    print(os.path.basename(f))
    for metric in ['ttfb','fcp','lcp']:
        tot=sum(r[metric+'_origins'] for r in m)
        if not tot: print('  ',metric,'none'); continue
        le=lambda x: 100*sum(r[metric+'_origins'] for r in m if r['loading_bucket']<x)/tot
        cum=0; med=None
        for r in sorted(m,key=lambda r:r['loading_bucket']):
            cum+=r[metric+'_origins']
            if med is None and cum>=tot/2: med=r['loading_bucket']
        print(f"   {metric.upper():4} n={tot:6} p75<400ms {le(400):5.1f}% | <800 {le(800):5.1f}% | <1000 {le(1000):5.1f}% | <1800 {le(1800):5.1f}% | <2500 {le(2500):5.1f}% | median origin p75 ~{med}-{med+100}ms")
