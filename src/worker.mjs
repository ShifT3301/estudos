// Worker: serve o app (assets estáticos) e uma API mínima de sincronização.
//   GET  /api/state  -> { data, updatedAt }
//   PUT  /api/state  -> body { data, base }  (base = updatedAt que o cliente viu por último)
// Tudo em /api/* exige "Authorization: Bearer <APP_TOKEN>".
// Se o servidor mudou desde `base`, responde 409 com o estado atual para o cliente mesclar.

const MAX_BYTES = 1_000_000;
const KEY = "state";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function validData(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.subjects) &&
    (data.deleted === undefined || (typeof data.deleted === "object" && data.deleted !== null))
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    if (url.pathname !== "/api/state") return json({ error: "not_found" }, 404);

    const token = env.APP_TOKEN;
    const auth = request.headers.get("Authorization") || "";
    if (!token || !(await safeEqual(auth, `Bearer ${token}`))) {
      return json({ error: "unauthorized" }, 401);
    }

    if (request.method === "GET") {
      const current = await env.STATE.get(KEY, "json");
      return json(current || { data: null, updatedAt: 0 });
    }

    if (request.method === "PUT") {
      const text = await request.text();
      if (text.length > MAX_BYTES) return json({ error: "too_large" }, 413);

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json({ error: "invalid_json" }, 400);
      }
      if (!body || !validData(body.data)) return json({ error: "invalid_body" }, 400);

      const current = await env.STATE.get(KEY, "json");
      const base = Number(body.base) || 0;
      if (current && current.updatedAt !== base) {
        return json({ conflict: true, ...current }, 409);
      }

      const updatedAt = Math.max(Date.now(), (current?.updatedAt || 0) + 1);
      await env.STATE.put(KEY, JSON.stringify({ data: body.data, updatedAt }));
      return json({ updatedAt });
    }

    return json({ error: "method_not_allowed" }, 405);
  },
};
