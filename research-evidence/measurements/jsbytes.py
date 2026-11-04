import re,sys,urllib.request,gzip,html
base=sys.argv[1]
def get(u):
    r=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=30);return r.read()
h=get(base).decode('utf8','replace')
srcs=set(re.findall(r'<script[^>]+src="([^"]+)"',h))|set(re.findall(r'<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"',h))|set(re.findall(r'<link[^>]+href="([^"]+)"[^>]+rel="modulepreload"',h))
inline=sum(len(m) for m in re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',h,re.S))
raw=gz=0
for s in srcs:
    u=urllib.parse.urljoin(base,html.unescape(s)); b=get(u); raw+=len(b); gz+=len(gzip.compress(b,9))
print(f"{base} html_raw={len(h)} html_gz={len(gzip.compress(h.encode(),9))} inline_js_chars={inline} external_js_files={len(srcs)} js_raw={raw} js_gz={gz}")
