import { Hono } from "hono";
import { render } from "../../shared/template.mjs";
const app = new Hono();
const page = (lang, font) => async (c) => {
  const nocache = c.req.query("nocache") !== undefined;
  const cache = caches.default;
  const key = new Request(new URL(c.req.path, c.req.url).toString());
  if (!nocache) { const hit = await cache.match(key); if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-s2-cache", "HIT"); return r; } }
  const t0 = Date.now();
  const res = new Response(render(lang, { font }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, s-maxage=600", "x-s2-cache": "MISS", "x-render-ms": String(Date.now() - t0) } });
  if (!nocache) c.executionCtx.waitUntil(cache.put(key, res.clone()));
  return res;
};
app.get("/", (c) => c.redirect("/fr/", 302));
app.get("/fr/", page("fr", "system"));
app.get("/ar/", page("ar", "kufi"));
app.get("/ar-sys/", page("ar", "system"));
app.post("/api/order", async (c) => { const f = await c.req.formData(); return c.text(/^0[567][0-9]{8}$/.test(f.get("phone") || "") ? "OK" : "Bad phone", 200); });
export default app;
