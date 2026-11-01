// Hacking N Robilex: servidor pronto pro Render (Postgres via DATABASE_URL, senão node:sqlite)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.mjs';

const HERE = import.meta.dirname;
const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(HERE, 'data/robilex.db');
const SEED = process.env.SEED || path.join(HERE, 'seed/lote1.json');
const FRONT = path.resolve(process.env.FRONT_DIR || path.join(HERE, 'public'));
const db = await openDb({ sqlitePath: DB_PATH });

const now = () => new Date().toISOString();
const typeOf = (t, url) => /^(mostra|show)/i.test(t) ? 'show' : /^(pergunta|ask|pergunte)/i.test(t) ? 'ask' : /^(vaga|contrata|job)/i.test(t) ? 'job' : (url ? 'story' : 'ask');

if ((await db.get('SELECT COUNT(*) n FROM users')).n === 0 && fs.existsSync(SEED)) {
  const d = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const OFF = Math.max(...d.posts.map(p => p.id)); // posts e comentários dividem a mesma sequência de ids, como no HN
  await db.tx(async t => {
    for (const u of d.users) await t.run('INSERT INTO users VALUES(?,?,?,?,?,?)', u.username, null, u.about ?? u.bio ?? '', u.karma ?? 1, u.is_demo ? 1 : 0, u.created_at ?? now());
    for (const p of d.posts) await t.run('INSERT INTO posts VALUES(?,?,?,?,?,?,?,?)', p.id, p.author, p.title, p.url || '', p.text || '', p.type || typeOf(p.title, p.url), p.points ?? 1, p.created_at ?? now());
    // pais antes dos filhos (chave estrangeira parent_id)
    const cs = [...d.comments], done = new Set(), ordered = [];
    while (cs.length) { const before = cs.length;
      for (let i = 0; i < cs.length; i++) { const c = cs[i], par = c.parent_id ?? c.parent_ref;
        if (!par || done.has(par) || !d.comments.some(x => x.id === par)) { ordered.push(c); done.add(c.id); cs.splice(i--, 1); } }
      if (cs.length === before) { ordered.push(...cs); break; } }
    for (const c of ordered) await t.run('INSERT INTO comments VALUES(?,?,?,?,?,?,?)', c.id + OFF, c.post_id ?? c.post_ref, (c.parent_id ?? c.parent_ref) ? (c.parent_id ?? c.parent_ref) + OFF : null, c.author, c.text, c.points ?? 1, c.created_at ?? now());
  });
  console.log('seeded from', SEED);
}

const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const verify = (pw, stored) => { if (!stored) return false; const [s] = stored.split(':'); const a = Buffer.from(hash(pw, s)), b = Buffer.from(stored); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const cookies = r => Object.fromEntries((r.headers.cookie || '').split(';').filter(Boolean).map(c => c.trim().split('=').map(x => { try { return decodeURIComponent(x); } catch { return x; } })));
const me = async r => { const t = cookies(r).sid; return t ? (await db.get('SELECT username FROM sessions WHERE token=?', t))?.username : undefined; };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const PAGE = 30;
const nextId = async () => Math.max((await db.get('SELECT COALESCE(MAX(id),0) m FROM posts')).m, (await db.get('SELECT COALESCE(MAX(id),0) m FROM comments')).m) + 1;
const voted = async (user, kind, id) => user ? !!(await db.get('SELECT 1 x FROM votes WHERE username=? AND kind=? AND item_id=?', user, kind, id)) : false;

const storyRow = async (p, user) => ({ ...p, domain: host(p.url),
  comments: (await db.get('SELECT COUNT(*) n FROM comments WHERE post_id=?', p.id)).n,
  voted: await voted(user, 'post', p.id),
  author_demo: !!(await db.get('SELECT is_demo FROM users WHERE username=?', p.author))?.is_demo });
const stories = (rows, u) => Promise.all(rows.map(p => storyRow(p, u)));

async function tree(postId, user) {
  const all = await db.all('SELECT c.*, u.is_demo author_demo FROM comments c JOIN users u ON u.username=c.author WHERE post_id=? ORDER BY points DESC, created_at, id', postId);
  const by = new Map();
  for (const c of all) by.set(c.id, { ...c, author_demo: !!c.author_demo, voted: await voted(user, 'comment', c.id), children: [] });
  const roots = [];
  for (const c of by.values()) (c.parent_id && by.get(c.parent_id) ? by.get(c.parent_id).children : roots).push(c);
  return roots;
}

const flat = async (rows, u) => { const out = []; for (const c of rows) out.push({ ...c, voted: await voted(u, 'comment', c.id) }); return out; };
const userRow = name => db.get('SELECT username, about, karma, is_demo, created_at FROM users WHERE username=?', name);
const routes = {
  'GET /api/users': async () => ({ users: (await db.all(`SELECT username, is_demo, karma, about, created_at FROM users ${db.usersOrder}`)).map(x => ({ ...x, is_demo: !!x.is_demo })) }),
  'GET /api/item2': async (q, u) => {
    const id = +q.get('id') || 0, p = await db.get('SELECT * FROM posts WHERE id=?', id);
    if (p) return { post: await storyRow(p, u), comments: await flat(await db.all('SELECT * FROM comments WHERE post_id=? ORDER BY points DESC, created_at, id', id), u) };
    const c = await db.get('SELECT * FROM comments WHERE id=?', id);
    if (!c) return [404, { error: 'Item não encontrado' }];
    const post = await db.get('SELECT * FROM posts WHERE id=?', c.post_id);
    return { comment: (await flat([c], u))[0], post: await storyRow(post, u), comments: await flat(await db.all('SELECT * FROM comments WHERE post_id=? ORDER BY points DESC, created_at, id', c.post_id), u) };
  },
  'GET /api/user2': async q => {
    const x = await userRow(q.get('id') || '');
    if (!x) return [404, { error: 'Usuário não encontrado' }];
    return { user: { ...x, is_demo: !!x.is_demo },
      posts: await stories(await db.all('SELECT * FROM posts WHERE author=? ORDER BY created_at DESC, id', x.username)),
      comments: await db.all('SELECT c.*, p.title post_title FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.author=? ORDER BY c.created_at DESC, c.id', x.username) };
  },
  'GET /api/comments': async () => ({ comments: await db.all('SELECT c.*, p.title post_title FROM comments c JOIN posts p ON p.id=c.post_id ORDER BY c.created_at DESC, c.id LIMIT 30') }),
  'GET /api/search': async (q, u) => { const s = (q.get('q') || '').trim(), t = '%' + s + '%'; return { stories: s ? await stories(await db.all('SELECT * FROM posts WHERE title LIKE ? OR text LIKE ? OR url LIKE ? ORDER BY points DESC, id LIMIT 60', t, t, t), u) : [] }; },
  'GET /api/stories': async (q, u) => {
    const type = q.get('type') || 'top', page = Math.max(1, +q.get('p') || 1), off = (page - 1) * PAGE;
    const where = { ask: "WHERE type='ask'", show: "WHERE type='show'", jobs: "WHERE type='job'" }[type] || '';
    const order = ['new', 'newest', 'front'].includes(type) ? 'created_at DESC, id' : db.rankExpr + ', id';
    const rows = await db.all(`SELECT * FROM posts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, PAGE + 1, off);
    return { page, more: rows.length > PAGE, stories: await stories(rows.slice(0, PAGE), u) };
  },
  'GET /api/item': async (q, u) => {
    const p = await db.get('SELECT * FROM posts WHERE id=?', +q.get('id') || 0);
    return p ? { story: await storyRow(p, u), comments: await tree(p.id, u) } : [404, { error: 'Item não encontrado' }];
  },
  'GET /api/user': async q => {
    const x = await userRow(q.get('id') || '');
    if (!x) return [404, { error: 'Usuário não encontrado' }];
    return { ...x, is_demo: !!x.is_demo,
      submissions: await db.all('SELECT id,title,points,created_at FROM posts WHERE author=? ORDER BY created_at DESC, id', x.username),
      comments: await db.all('SELECT id,post_id,text,created_at FROM comments WHERE author=? ORDER BY created_at DESC, id LIMIT 30', x.username) };
  },
  'GET /api/newcomments': async () => ({ comments: await db.all('SELECT c.*, p.title post_title FROM comments c JOIN posts p ON p.id=c.post_id ORDER BY c.created_at DESC, c.id LIMIT 30') }),
  'GET /api/me': async (q, u) => { const x = u && await db.get('SELECT username, karma, is_demo FROM users WHERE username=?', u); return { user: x ? { ...x, is_demo: !!x.is_demo } : null, username: x?.username ?? null }; },
  'POST /api/signup': async (q, u, b, res) => {
    const name = String(b.username || '').trim();
    if (!/^[A-Za-z0-9_.-]{2,15}$/.test(name)) return [400, { error: 'Nome deve ter 2 a 15 letras, números, _ . ou -' }];
    if (String(b.password || '').length < 8) return [400, { error: 'Senha precisa de pelo menos 8 caracteres' }];
    if (await db.get('SELECT 1 x FROM users WHERE lower(username)=lower(?)', name)) return [409, { error: 'Esse nome já existe' }];
    await db.run('INSERT INTO users(username,pass,created_at) VALUES(?,?,?)', name, hash(b.password), now());
    return login(name, res);
  },
  'POST /api/login': async (q, u, b, res) => {
    const x = await db.get('SELECT username, pass FROM users WHERE username=?', String(b.username || ''));
    return x && verify(String(b.password || ''), x.pass) ? login(x.username, res) : [401, { error: 'Login ou senha incorretos' }];
  },
  'POST /api/logout': async (q, u, b, res, r) => { await db.run('DELETE FROM sessions WHERE token=?', cookies(r).sid || ''); res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true }; },
  'POST /api/submit': async (q, u, b) => {
    if (!u) return [401, { error: 'Faça login' }];
    const title = String(b.title || '').trim(), url = String(b.url || '').trim(), text = String(b.text || '').trim();
    if (!title || title.length > 80) return [400, { error: 'Título obrigatório (até 80 caracteres)' }];
    if (url && !/^https?:\/\//.test(url)) return [400, { error: 'URL inválida' }];
    const id = await nextId();
    await db.run('INSERT INTO posts(id,author,title,url,text,type,points,created_at) VALUES(?,?,?,?,?,?,1,?)', id, u, title, url, text, typeOf(title, url), now());
    return { id };
  },
  'POST /api/comment': async (q, u, b) => {
    if (!u) return [401, { error: 'Faça login' }];
    const text = String(b.text || '').trim(); if (!text) return [400, { error: 'Comentário vazio' }];
    let post = +b.post_id || 0, parent = b.parent_id ? +b.parent_id || 0 : null;
    if (parent) { const pc = await db.get('SELECT post_id FROM comments WHERE id=?', parent); if (!pc) return [404, { error: 'Comentário não encontrado' }]; post = pc.post_id; }
    if (!await db.get('SELECT 1 x FROM posts WHERE id=?', post)) return [404, { error: 'Post não encontrado' }];
    const id = await nextId();
    await db.run('INSERT INTO comments(id,post_id,parent_id,author,text,points,created_at) VALUES(?,?,?,?,?,1,?)', id, post, parent, u, text, now());
    return { id, post_id: post };
  },
  'POST /api/vote': async (q, u, b) => {
    if (!u) return [401, { error: 'Faça login' }];
    const kind = b.kind === 'comment' ? 'comment' : 'post', id = +b.id || 0, table = kind === 'post' ? 'posts' : 'comments';
    const item = await db.get(`SELECT author FROM ${table} WHERE id=?`, id); if (!item) return [404, { error: 'Item não encontrado' }];
    if (item.author === u) return [400, { error: 'Não dá pra votar em si mesmo' }];
    const had = await db.get('SELECT 1 x FROM votes WHERE username=? AND kind=? AND item_id=?', u, kind, id), d = had ? -1 : 1;
    await db.tx(async t => {
      await t.run(had ? 'DELETE FROM votes WHERE username=? AND kind=? AND item_id=?' : 'INSERT INTO votes VALUES(?,?,?)', u, kind, id);
      await t.run(`UPDATE ${table} SET points=points+? WHERE id=?`, d, id);
      await t.run('UPDATE users SET karma=karma+? WHERE username=?', d, item.author);
    });
    return { voted: !had, points: (await db.get(`SELECT points FROM ${table} WHERE id=?`, id)).points };
  },
};
async function login(name, res) {
  const t = crypto.randomBytes(24).toString('hex');
  await db.run('INSERT INTO sessions VALUES(?,?,?)', t, name, now());
  res.setHeader('Set-Cookie', `sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  return { username: name };
}

// escritas em fila única: evita corrida no nextId() e no voto (uma instância só)
let queue = Promise.resolve();
const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.gif': 'image/gif' };
const server = http.createServer(async (r, res) => {
  const url = new URL(r.url, 'http://x');
  const m = url.pathname.match(/^\/api\/(item|user)\/(.+)$/);
  if (m) { let v = m[2]; try { v = decodeURIComponent(v); } catch {} url.searchParams.set('id', v); }
  const key = m ? `${r.method} /api/${m[1]}2` : `${r.method} ${url.pathname}`;
  if (url.pathname.startsWith('/api/')) {
    let out, code = 200;
    try {
      const fn = routes[key];
      let body = {};
      if (r.method === 'POST') { let s = ''; for await (const c of r) s += c; try { body = r.headers['content-type']?.includes('json') ? JSON.parse(s || '{}') : Object.fromEntries(new URLSearchParams(s)); } catch { body = {}; } if (!body || typeof body !== 'object') body = {}; }
      const u = await me(r);
      out = !fn ? [404, { error: 'Rota não existe' }] : r.method === 'POST' ? await serial(() => fn(url.searchParams, u, body, res, r)) : await fn(url.searchParams, u, body, res, r);
    } catch (e) { console.error(key, e); out = [500, { error: 'Erro interno, tente de novo' }]; }
    if (Array.isArray(out)) [code, out] = out;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(out));
  }
  let f = path.join(FRONT, path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, ''));
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f) && !path.extname(f)) f = fs.existsSync(f + '.html') ? f + '.html' : path.join(FRONT, 'index.html');
  if (!f.startsWith(FRONT) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
server.listen(PORT, '0.0.0.0', () => console.log(`Hacking N Robilex on :${PORT} (db: ${db.kind})`));
const stop = () => server.close(() => db.close().finally(() => process.exit(0)));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
