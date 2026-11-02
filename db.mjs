// Camada de banco: Postgres (pg) quando DATABASE_URL existe, senão node:sqlite.
// As consultas usam "?" como placeholder; no Postgres viram $1, $2...
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, pass TEXT, about TEXT DEFAULT '', karma INT DEFAULT 1, is_demo INT DEFAULT 0, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS posts(id INTEGER PRIMARY KEY, author TEXT REFERENCES users, title TEXT, url TEXT, text TEXT, type TEXT, points INT DEFAULT 1, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, post_id INT REFERENCES posts, parent_id INT REFERENCES comments, author TEXT REFERENCES users, text TEXT, points INT DEFAULT 1, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS votes(username TEXT, kind TEXT, item_id INT, PRIMARY KEY(username,kind,item_id))`,
  `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)`,
];

// Decide SSL: DATABASE_SSL=true/false força; senão, URL externa do Render (host com ".render.com") usa SSL,
// URL interna (host "dpg-xxxx-a", sem domínio) e localhost vão sem SSL. sslmode=disable na URL também desliga.
function sslFor(urlStr) {
  const env = (process.env.DATABASE_SSL || '').toLowerCase();
  if (['1', 'true', 'require', 'on'].includes(env)) return { rejectUnauthorized: false };
  if (['0', 'false', 'disable', 'off'].includes(env)) return false;
  let u; try { u = new URL(urlStr); } catch { return false; }
  const mode = u.searchParams.get('sslmode');
  if (mode === 'disable') return false;
  if (mode && mode !== 'disable') return { rejectUnauthorized: false };
  return /\.render\.com$/i.test(u.hostname) ? { rejectUnauthorized: false } : false;
}

export async function openDb({ sqlitePath }) {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    pg.types.setTypeParser(20, Number);   // int8 (COUNT) -> number
    pg.types.setTypeParser(1700, Number); // numeric -> number
    const clean = new URL(url); clean.searchParams.delete('sslmode'); // SSL é decidido por sslFor()
    const pool = new pg.Pool({ connectionString: clean.toString(), ssl: sslFor(url), max: 5 });
    pool.on('error', e => console.error('pg pool error', e.message));
    const conv = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)).replace(/\bLIKE\b/g, 'ILIKE'); };
    const wrap = q => ({
      all: async (sql, ...p) => (await q(conv(sql), p)).rows,
      get: async (sql, ...p) => (await q(conv(sql), p)).rows[0],
      run: async (sql, ...p) => { await q(conv(sql), p); },
    });
    const api = wrap((s, p) => pool.query(s, p));
    api.kind = 'postgres';
    api.exec = async sql => { await pool.query(sql); };
    api.tx = async fn => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(wrap((s, p) => c.query(s, p))); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    };
    // ranking estilo HN: (pontos-1) / (horas+2)^1.8
    api.rankExpr = "(points-1) / power(extract(epoch from (now() - created_at::timestamptz))/3600 + 2, 1.8) DESC";
    // created_at é texto ISO: COLLATE "C" garante a mesma ordenação byte a byte do SQLite
    // seq guarda a ordem de inserção dos usuários (o SQLite usa o rowid)
    for (const s of SCHEMA) await pool.query(s.replace(/created_at TEXT/g, 'created_at TEXT COLLATE "C"').replace(/(CREATE TABLE IF NOT EXISTS users\(.*)\)$/, '$1, seq SERIAL)'));
    api.usersOrder = 'ORDER BY seq';
    api.close = () => pool.end();
    return api;
  }
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec('PRAGMA foreign_keys=ON;');
  for (const s of SCHEMA) db.exec(s);
  const api = {
    kind: 'sqlite:' + sqlitePath,
    all: async (sql, ...p) => db.prepare(sql).all(...p),
    get: async (sql, ...p) => db.prepare(sql).get(...p),
    run: async (sql, ...p) => { db.prepare(sql).run(...p); },
    exec: async sql => db.exec(sql),
    rankExpr: "(points-1) / pow((julianday('now')-julianday(created_at))*24+2, 1.8) DESC",
    close: async () => db.close(),
    usersOrder: 'ORDER BY rowid',
  };
  api.tx = async fn => { db.exec('BEGIN'); try { const r = await fn(api); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  return api;
}
