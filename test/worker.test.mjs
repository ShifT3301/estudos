import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { getPlatformProxy } from "wrangler";
import worker from "../src/worker.mjs";

let proxy;
let env;

before(async () => {
  proxy = await getPlatformProxy({ configPath: new URL("../wrangler.jsonc", import.meta.url).pathname, persist: false });
  env = { DB: proxy.env.DB, INVITE_CODE: "convite-teste", ASSETS: { fetch: () => new Response("asset") } };
});
after(async () => {
  await proxy.dispose();
});

let ipCounter = 0;
async function call(method, path, { body, token, ip } = {}) {
  const headers = { "CF-Connecting-IP": ip || `10.0.0.${++ipCounter}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch(
    new Request(`https://x.dev${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  return { status: res.status, json: await res.json().catch(() => null) };
}
const register = (username, password = "senha-boa-123", invite = "convite-teste") =>
  call("POST", "/api/register", { body: { username, password, invite } });

test("cadastro exige convite, usuário e senha válidos", async () => {
  assert.equal((await register("ana", "senha-boa-123", "errado")).status, 403);
  assert.equal((await register("a")).status, 400);
  assert.equal((await register("Ana Maria")).status, 400);
  assert.equal((await register("ana", "curta")).status, 400);
  const ok = await register("Ana");
  assert.equal(ok.status, 200);
  assert.equal(ok.json.username, "ana"); // normaliza para minúsculas
  assert.match(ok.json.token, /^[0-9a-f]{64}$/);
  assert.equal((await register("ANA")).status, 409);
});

test("cadastro fechado se INVITE_CODE não estiver configurado", async () => {
  const saved = env.INVITE_CODE;
  env.INVITE_CODE = undefined;
  assert.equal((await register("fechado")).status, 503);
  env.INVITE_CODE = saved;
});

test("login: senha certa entra, errada não; senha não fica em texto puro", async () => {
  await register("bia", "minha-senha-forte");
  const ok = await call("POST", "/api/login", { body: { username: "BIA", password: "minha-senha-forte" } });
  assert.equal(ok.status, 200);
  assert.equal((await call("POST", "/api/login", { body: { username: "bia", password: "errada!!" } })).status, 401);
  assert.equal((await call("POST", "/api/login", { body: { username: "naoexiste", password: "qualquer-coisa" } })).status, 401);
  const row = await env.DB.prepare("SELECT hash, salt FROM users WHERE username = 'bia'").first();
  assert.ok(!JSON.stringify(row).includes("minha-senha-forte"));
  assert.equal(row.hash.length, 64);
  const sess = await env.DB.prepare("SELECT token_hash FROM sessions").all();
  assert.ok(sess.results.every((s) => s.token_hash !== ok.json.token)); // só o hash do token é guardado
});

test("bloqueia depois de muitas senhas erradas", async () => {
  await register("caio", "senha-do-caio-1");
  const ip = "9.9.9.9";
  for (let i = 0; i < 8; i++) {
    assert.equal((await call("POST", "/api/login", { body: { username: "caio", password: "x".repeat(9) }, ip })).status, 401);
  }
  assert.equal((await call("POST", "/api/login", { body: { username: "caio", password: "senha-do-caio-1" }, ip })).status, 429);
});

test("estado: exige sessão, cada usuário vê só o seu, conflito protege contra sobrescrita", async () => {
  const a = (await register("dani", "senha-da-dani-1")).json.token;
  const b = (await register("edu", "senha-do-edu-123")).json.token;

  assert.equal((await call("GET", "/api/state")).status, 401);
  assert.equal((await call("GET", "/api/state", { token: "0".repeat(64) })).status, 401);
  assert.deepEqual((await call("GET", "/api/state", { token: a })).json, { data: null, updatedAt: 0 });

  const put1 = await call("PUT", "/api/state", { token: a, body: { data: { subjects: [{ id: "farma" }] }, base: 0 } });
  assert.equal(put1.status, 200);

  // usuário B não enxerga o estado de A
  assert.equal((await call("GET", "/api/state", { token: b })).json.data, null);

  // base desatualizada => 409 com o estado atual
  const stale = await call("PUT", "/api/state", { token: a, body: { data: { subjects: [] }, base: 0 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.data.subjects[0].id, "farma");
  assert.equal(stale.json.updatedAt, put1.json.updatedAt);

  const put2 = await call("PUT", "/api/state", { token: a, body: { data: { subjects: [{ id: "imuno" }] }, base: put1.json.updatedAt } });
  assert.equal(put2.status, 200);
  assert.equal((await call("GET", "/api/state", { token: a })).json.data.subjects[0].id, "imuno");

  assert.equal((await call("PUT", "/api/state", { token: a, body: { data: { foo: 1 } } })).status, 400);
});

test("logout invalida a sessão", async () => {
  const token = (await register("fabi", "senha-da-fabi-1")).json.token;
  assert.equal((await call("GET", "/api/state", { token })).status, 200);
  assert.equal((await call("POST", "/api/logout", { token })).status, 200);
  assert.equal((await call("GET", "/api/state", { token })).status, 401);
});

test("arquivos estáticos e rotas desconhecidas", async () => {
  const asset = await worker.fetch(new Request("https://x.dev/"), env);
  assert.equal(await asset.text(), "asset");
  assert.equal((await call("GET", "/api/outra")).status, 404);
});
