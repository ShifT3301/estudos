// Worker: serve o app (assets estáticos) e a API de contas + sincronização.
//
//   POST /api/register  { username, password, invite }  -> { token, username }
//   POST /api/login     { username, password }          -> { token, username }
//   POST /api/logout                                    -> { ok: true }
//   GET  /api/state                                     -> { data, updatedAt }
//   PUT  /api/state     { data, base }                  -> { updatedAt }  | 409 { conflict, data, updatedAt }
//
// /api/state e /api/logout exigem "Authorization: Bearer <token de sessão>".
// Cada usuário só enxerga o próprio estado. Cadastro exige o código de convite (secret INVITE_CODE).
// Senhas: PBKDF2-SHA256 com salt individual. Sessões: o token vai ao cliente; no banco fica só o hash.

const MAX_BYTES = 1_000_000;
const PBKDF2_ITERATIONS = 100_000; // máximo aceito pelo WebCrypto do Workers
const SESSION_MS = 90 * 24 * 3600 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const LIMITS = { login: 8, ip: 40, register: 10 };
const USERNAME_RE = /^[a-z0-9_.-]{3,30}$/;

const enc = new TextEncoder();

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
const fail = (status, error, message) => json({ error, message }, status);

// ---------- utilidades criptográficas ----------
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return toHex(bits);
}

function equalHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function safeEqual(a, b) {
  return equalHex(await sha256Hex(a), await sha256Hex(b));
}

// ---------- banco ----------
let schemaReady = null;
function ensureSchema(db) {
  schemaReady ||= db
    .batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
      ),
      db.prepare(
        "CREATE TABLE IF NOT EXISTS states (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)",
      ),
      db.prepare("CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)"),
    ])
    .catch((err) => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

// Limite de tentativas erradas por chave (usuário, IP) numa janela de 15 minutos.
async function isBlocked(db, key, limit) {
  const row = await db.prepare("SELECT count, reset_at FROM attempts WHERE key = ?").bind(key).first();
  return !!row && row.reset_at > Date.now() && row.count >= limit;
}
async function recordFailure(db, key) {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO attempts (key, count, reset_at) VALUES (?, 1, ?) " +
        "ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END, " +
        "reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END",
    )
    .bind(key, now + WINDOW_MS, now, now, now + WINDOW_MS)
    .run();
}
const clearFailures = (db, key) => db.prepare("DELETE FROM attempts WHERE key = ?").bind(key).run();

async function createSession(db, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    db.prepare("DELETE FROM attempts WHERE reset_at < ?").bind(now),
    db
      .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256Hex(token), userId, now + SESSION_MS),
  ]);
  return token;
}

async function authenticate(db, request) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
  if (!m) return null;
  const tokenHash = await sha256Hex(m[1]);
  return db
    .prepare(
      "SELECT s.user_id AS userId, s.token_hash AS tokenHash, u.username AS username " +
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(tokenHash, Date.now())
    .first();
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return { tooLarge: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}

function validData(data) {
  return (
    data &&
    typeof data === "object" &&
    Array.isArray(data.subjects) &&
    (data.deleted === undefined || (typeof data.deleted === "object" && data.deleted !== null))
  );
}

// ---------- rotas ----------
async function register(request, env, ip) {
  const db = env.DB;
  if (!env.INVITE_CODE) return fail(503, "closed", "Cadastro desativado: o código de convite ainda não foi configurado.");
  if (await isBlocked(db, `register:${ip}`, LIMITS.register)) return fail(429, "rate_limited", "Muitas tentativas. Tente de novo em alguns minutos.");

  const { body, invalid, tooLarge } = await readJson(request);
  if (invalid || tooLarge || !body) return fail(400, "invalid_body", "Requisição inválida.");

  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!(await safeEqual(String(body.invite || "").trim(), env.INVITE_CODE))) {
    await recordFailure(db, `register:${ip}`);
    return fail(403, "bad_invite", "Código de convite incorreto.");
  }
  if (!USERNAME_RE.test(username)) return fail(400, "bad_username", "Usuário: 3 a 30 caracteres, só letras, números, ponto, hífen e _.");
  if (password.length < 8 || password.length > 200) return fail(400, "bad_password", "A senha precisa ter de 8 a 200 caracteres.");

  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  const res = await db
    .prepare("INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO NOTHING")
    .bind(username, salt, hash, Date.now())
    .run();
  if (!res.meta.changes) return fail(409, "username_taken", "Esse usuário já existe. Escolha outro.");

  const user = await db.prepare("SELECT id FROM users WHERE username = ?").bind(username).first();
  return json({ token: await createSession(db, user.id), username });
}

async function login(request, env, ip) {
  const db = env.DB;
  const { body, invalid, tooLarge } = await readJson(request);
  if (invalid || tooLarge || !body) return fail(400, "invalid_body", "Requisição inválida.");

  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "").slice(0, 200);
  const userKey = `login:${username}`;
  const ipKey = `ip:${ip}`;
  if ((await isBlocked(db, userKey, LIMITS.login)) || (await isBlocked(db, ipKey, LIMITS.ip))) {
    return fail(429, "rate_limited", "Muitas tentativas. Tente de novo em alguns minutos.");
  }

  const user = await db.prepare("SELECT id, salt, hash FROM users WHERE username = ?").bind(username).first();
  // Mesmo sem usuário, calcula um hash para o tempo de resposta não revelar se a conta existe.
  const computed = await hashPassword(password, user ? user.salt : "00".repeat(16));
  if (!user || !equalHex(computed, user.hash)) {
    await Promise.all([recordFailure(db, userKey), recordFailure(db, ipKey)]);
    return fail(401, "bad_credentials", "Usuário ou senha incorretos.");
  }
  await clearFailures(db, userKey);
  return json({ token: await createSession(db, user.id), username });
}

async function state(request, env) {
  const db = env.DB;
  const session = await authenticate(db, request);
  if (!session) return fail(401, "unauthorized", "Sessão inválida ou expirada.");

  if (request.method === "POST" && new URL(request.url).pathname === "/api/logout") {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
    return json({ ok: true });
  }

  const current = async () => {
    const row = await db.prepare("SELECT data, updated_at AS updatedAt FROM states WHERE user_id = ?").bind(session.userId).first();
    return row ? { data: JSON.parse(row.data), updatedAt: row.updatedAt } : { data: null, updatedAt: 0 };
  };

  if (request.method === "GET") return json(await current());

  if (request.method === "PUT") {
    const { body, invalid, tooLarge } = await readJson(request);
    if (tooLarge) return fail(413, "too_large", "Dados grandes demais.");
    if (invalid) return fail(400, "invalid_json", "JSON inválido.");
    if (!body || !validData(body.data)) return fail(400, "invalid_body", "Formato inválido.");

    const base = Number(body.base) || 0;
    const updatedAt = Math.max(Date.now(), base + 1);
    const payload = JSON.stringify(body.data);
    // Gravação condicional (compare-and-set): só grava se ninguém mudou desde `base`.
    const res =
      base === 0
        ? await db
            .prepare("INSERT INTO states (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING")
            .bind(session.userId, payload, updatedAt)
            .run()
        : await db
            .prepare("UPDATE states SET data = ?, updated_at = ? WHERE user_id = ? AND updated_at = ?")
            .bind(payload, updatedAt, session.userId, base)
            .run();
    if (!res.meta.changes) return json({ conflict: true, ...(await current()) }, 409);
    return json({ updatedAt });
  }

  return fail(405, "method_not_allowed", "Método não permitido.");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      await ensureSchema(env.DB);
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const { pathname } = url;
      const method = request.method;

      if (pathname === "/api/register" && method === "POST") return await register(request, env, ip);
      if (pathname === "/api/login" && method === "POST") return await login(request, env, ip);
      if (pathname === "/api/state" || (pathname === "/api/logout" && method === "POST")) return await state(request, env);
      return fail(404, "not_found", "Não encontrado.");
    } catch (err) {
      console.error(err);
      return fail(500, "server_error", "Erro no servidor. Tente de novo.");
    }
  },
};
