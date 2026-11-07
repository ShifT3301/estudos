import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.mjs";

function makeEnv(token = "segredo") {
  const store = new Map();
  return {
    APP_TOKEN: token,
    ASSETS: { fetch: () => new Response("asset") },
    STATE: {
      get: async (k, type) => (store.has(k) ? (type === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null),
      put: async (k, v) => void store.set(k, v),
    },
  };
}
const req = (method, body, token = "segredo") =>
  new Request("https://x.dev/api/state", {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("sem senha ou senha errada: 401", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("GET", undefined, null), env)).status, 401);
  assert.equal((await worker.fetch(req("GET", undefined, "errada"), env)).status, 401);
  assert.equal((await worker.fetch(req("GET"), makeEnv(""))).status, 401); // sem APP_TOKEN configurada
});

test("fluxo GET/PUT com controle de conflito", async () => {
  const env = makeEnv();
  let r = await (await worker.fetch(req("GET"), env)).json();
  assert.deepEqual(r, { data: null, updatedAt: 0 });

  const put1 = await worker.fetch(req("PUT", { data: { subjects: [] }, base: 0 }), env);
  assert.equal(put1.status, 200);
  const { updatedAt } = await put1.json();

  const stale = await worker.fetch(req("PUT", { data: { subjects: [{ id: "a" }] }, base: 0 }), env);
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.updatedAt, updatedAt);

  const put2 = await worker.fetch(req("PUT", { data: { subjects: [{ id: "a" }] }, base: updatedAt }), env);
  assert.equal(put2.status, 200);
  r = await (await worker.fetch(req("GET"), env)).json();
  assert.equal(r.data.subjects[0].id, "a");
});

test("corpo inválido: 400; outras rotas", async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(req("PUT", { data: { foo: 1 } }), env)).status, 400);
  assert.equal(await (await worker.fetch(new Request("https://x.dev/"), env)).text(), "asset");
  assert.equal((await worker.fetch(new Request("https://x.dev/api/outra", { headers: { Authorization: "Bearer segredo" } }), env)).status, 404);
});
