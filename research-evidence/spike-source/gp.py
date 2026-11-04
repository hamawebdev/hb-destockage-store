import json, sys, time, urllib.request
API="https://api.globalping.io/v1/measurements"
def post(body):
    r=urllib.request.Request(API,data=json.dumps(body).encode(),headers={"content-type":"application/json"},method="POST")
    return json.load(urllib.request.urlopen(r,timeout=60))["id"]
def get(i):
    while True:
        m=json.load(urllib.request.urlopen(f"{API}/{i}",timeout=60))
        if m["status"]!="in-progress": return m
        time.sleep(2)
locs=[{"country":"MA","limit":2},{"country":"TN","limit":1},{"country":"FR","limit":2},{"country":"ES","limit":2},{"country":"IT","limit":2}]
out={}
for host,path in [(a,b) for a in sys.argv[1].split(",") for b in sys.argv[2].split(",")]:
    for rep in range(int(sys.argv[3])):
        body={"type":"http","target":host,"locations":locs,"measurementOptions":{"protocol":"HTTPS","request":{"method":"GET","path":path,"headers":{"accept-encoding":"br, gzip","user-agent":"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36","accept":"text/html,application/xhtml+xml"}}}}
        try: m=get(post(body))
        except Exception as e: print("ERR",host,path,e); continue
        for r in m["results"]:
            p=r["probe"]; res=r["result"]; t=res.get("timings") or {}
            h=res.get("headers") or {}; ray=h.get("cf-ray",""); colo=ray.split("-")[-1] if ray else "?"
            line=dict(host=host,path=path,rep=rep,cc=p["country"],city=p["city"],asn=p["asn"],net=p["network"],status=res.get("statusCode"),colo=colo,cache=h.get("cf-cache-status") or h.get("x-s2-cache"),**{k:t.get(k) for k in ["total","dns","tcp","tls","firstByte","download"]})
            print(json.dumps(line,ensure_ascii=False),flush=True)
        time.sleep(1)
