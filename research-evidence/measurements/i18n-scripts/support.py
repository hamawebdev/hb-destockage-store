import json,sys,re
cu=json.load(open(sys.argv[1])); dz=json.load(open(sys.argv[2]))['data']; bcd=json.load(open(sys.argv[3]))
last=cu['agents']['and_chr']['version_list'][-1]['version']; dz['and_chr']={last:dz['and_chr'].get('0',0)}
def vnum(v):
    m=re.match(r'(\d+(?:\.\d+)?)',v or ''); return float(m.group(1)) if m else None
def cu_support(fid):
    s=cu['data'][fid]['stats']; tot=0; mob=0; mobt=0
    for agent,vers in dz.items():
        for v,u in vers.items():
            if not u: continue
            st=s.get(agent,{}).get(v,'n')
            ok=st.startswith('y') or st.startswith('a')
            if ok: tot+=u
            if agent in('and_chr','ios_saf','samsung','op_mob','and_uc','and_ff','android','op_mini','and_qq','kaios','baidu'):
                mobt+=u; mob+= u if ok else 0
    return tot, mob/mobt*100
amap={'and_chr':'chrome_android','chrome':'chrome','ios_saf':'safari_ios','safari':'safari','samsung':'samsunginternet_android','firefox':'firefox','and_ff':'firefox_android','edge':'edge','opera':'opera','op_mob':'opera_android','android':'webview_android'}
def bcd_get(path):
    n=bcd
    for p in path.split('.'): n=n[p]
    return n['__compat']['support']
def bcd_support(path):
    sup=bcd_get(path); tot=0; mob=0; mobt=0
    for agent,vers in dz.items():
        b=amap.get(agent)
        for v,u in vers.items():
            if not u: continue
            ok=False
            if b and b in sup:
                e=sup[b]; e=e[0] if isinstance(e,list) else e
                va=e.get('version_added')
                if va and va is not True and not e.get('flags') and not e.get('prefix') and va!='preview':
                    vv=vnum(va.lstrip('≤')); cur=vnum(v.split('-')[0])
                    if agent=='ios_saf' and '-' in v: cur=vnum(v.split('-')[-1])
                    ok = cur is not None and vv is not None and cur>=vv
                    vr=e.get('version_removed')
                    if vr and cur>=vnum(vr): ok=False
            if ok: tot+=u
            if agent in('and_chr','ios_saf','samsung','op_mob','and_uc','and_ff','android','op_mini','and_qq','kaios','baidu'):
                mobt+=u; mob+= u if ok else 0
    return tot, mob/mobt*100, {k:(sup[k][0] if isinstance(sup[k],list) else sup[k]).get('version_added') for k in ('chrome_android','safari_ios','samsunginternet_android') if k in sup}
for f in ['cross-document-view-transitions','view-transitions','css-container-queries','css-logical-props','css-has','css-nesting','css-text-wrap-balance','variable-fonts','woff2','font-unicode-range','css-cascade-layers','css-dir-pseudo','css-anchor-positioning','css-lch-lab']:
    t,m=cu_support(f); print(f"caniuse {f:36s} all-DZ {t:5.1f}%  mobile-DZ {m:5.1f}%")
for p in ['css.at-rules.starting-style','css.properties.animation-timeline','css.properties.animation-timeline.scroll','css.properties.animation-timeline.view','css.at-rules.font-face.size-adjust','css.at-rules.font-face.ascent-override','css.at-rules.view-transition','api.HTMLElement.popover','css.properties.interpolate-size','css.properties.text-wrap.pretty','css.types.color.oklch','css.properties.field-sizing','html.elements.dialog','css.selectors.dir','api.Document.startViewTransition','css.properties.content-visibility']:
    try:
        t,m,vs=bcd_support(p); print(f"bcd {p:44s} all-DZ {t:5.1f}%  mobile-DZ {m:5.1f}%  {vs}")
    except Exception as e: print('ERR',p,e)
