import json, sys

def R(x, n=0):
    return None if x is None else round(x, n)

for f in sys.argv[1:]:
    try:
        r = json.load(open(f))
    except Exception as e:
        print(json.dumps({"file": f.split("/")[-1], "err": str(e)})); continue
    a = r["audits"]
    g = lambda k: a.get(k, {}).get("numericValue")
    items = (a.get("network-requests", {}).get("details") or {}).get("items", [])
    by = {}
    for it in items:
        t = it.get("resourceType", "?"); by[t] = by.get(t, 0) + (it.get("transferSize") or 0)
    status = items[0].get("statusCode") if items else None
    ts = r["configSettings"]["throttling"]
    print(json.dumps({"file": f.split("/")[-1], "url": r.get("finalDisplayedUrl"), "status": status,
        "rterr": (r.get("runtimeError") or {}).get("code"),
        "score": R((r["categories"]["performance"]["score"] or 0) * 100),
        "fcp": R(g("first-contentful-paint")), "lcp": R(g("largest-contentful-paint")), "tbt": R(g("total-blocking-time")),
        "cls": R(g("cumulative-layout-shift"), 3), "si": R(g("speed-index")), "ttfb": R(g("server-response-time")),
        "bytes": g("total-byte-weight"), "by_type": by, "n_req": len(items),
        "bench": r["environment"].get("benchmarkIndex"), "throttle": r["configSettings"]["throttlingMethod"],
        "rtt": ts.get("rttMs"), "kbps": ts.get("throughputKbps"), "cpu": ts.get("cpuSlowdownMultiplier"),
        "a11y": R(((r["categories"].get("accessibility") or {}).get("score") or 0) * 100)}))
