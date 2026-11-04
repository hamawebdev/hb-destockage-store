export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/order" && req.method === "POST") {
      const f = await req.formData();
      if (f.get("hp")) return new Response(null, { status: 204 });
      const ok = /^0[567][0-9]{8}$/.test(f.get("phone") || "");
      return new Response(ok ? "OK" : "Bad phone", { status: ok ? 200 : 422 });
    }
    return env.ASSETS.fetch(req);
  },
};
