// Hacking N Robilex - front. Fala com a API em /api; se a API nao responder, usa /lote1.json como modo demo (somente leitura).
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qs = new URLSearchParams(location.search);
let ME = null, MOCK = null, USERS = {};
const voted = new Set();

// Adaptador pra API do back (server.mjs do Crawling helper)
async function raw(path, opts = {}) {
  const r = await fetch('/api' + path, {credentials: 'same-origin', headers: {'Content-Type': 'application/json'}, ...opts});
  if (!(r.headers.get('content-type') || '').includes('json')) throw Object.assign(new Error('noapi'), {noapi: true});
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Erro ' + r.status), {api: true});
  return d;
}
const TYPE = {news: 'top', newest: 'new', front: 'new', ask: 'ask', show: 'show', jobs: 'jobs'};
function seen(x) { if (!x) return x; if (x.author) USERS[x.author] = {...(USERS[x.author] || {}), is_demo: !!x.author_demo}; if (x.voted) voted.add((x.title !== undefined ? 'post' : 'comment') + x.id); return x; }
const flat = (cs, out = []) => { for (const c of cs || []) { seen(c); out.push(c); flat(c.children, out); } return out; };
async function real(path, opts) {
  const u = new URL(path, 'http://x'), P = u.searchParams, seg = u.pathname.split('/');
  if (opts.method) { const d = await raw(path, opts); return d; }
  if (u.pathname === '/me') { const d = await raw('/me'); return {user: d.username ? d : null}; }
  if (u.pathname === '/users') return {users: []};
  if (u.pathname === '/stories') { const d = await raw(`/stories?type=${TYPE[P.get('type')] || 'top'}&p=${P.get('p') || 1}`); d.stories.forEach(seen); return d; }
  if (seg[1] === 'item') {
    const id = seg[2];
    try { const d = await raw('/item?id=' + id); return {post: seen(d.story), comments: flat(d.comments)}; }
    catch (e) {
      const nc = await raw('/newcomments'); let c = nc.comments.find(x => x.id == id);
      if (!c) throw e;
      const d = await raw('/item?id=' + c.post_id); const all = flat(d.comments);
      return {comment: all.find(x => x.id == id) || c, post: seen(d.story), comments: all};
    }
  }
  if (seg[1] === 'user') {
    const n = decodeURIComponent(seg[2]); const d = await raw('/user?id=' + encodeURIComponent(n));
    USERS[n] = d;
    const titles = Object.fromEntries(d.submissions.map(p => [p.id, p.title]));
    return {user: d, posts: d.submissions.map(p => ({...p, author: n, url: '', comments: p.comments})), comments: d.comments.map(c => ({...c, author: n, post_title: c.post_title || titles[c.post_id]}))};
  }
  if (u.pathname === '/comments') { const d = await raw('/newcomments'); d.comments.forEach(seen); return d; }
  if (u.pathname === '/search') {
    const q = (P.get('q') || '').toLowerCase(), out = [];
    for (let p = 1; p < 20; p++) { const d = await raw('/stories?type=new&p=' + p); d.stories.forEach(seen); out.push(...d.stories); if (!d.more) break; }
    return {stories: out.filter(s => (s.title + ' ' + (s.text || '') + ' ' + (s.domain || '')).toLowerCase().includes(q))};
  }
  return raw(path);
}
async function api(path, opts = {}) {
  if (MOCK && !opts.method) return mockApi(path);
  try { return await real(path, opts); }
  catch (e) { if (e.noapi && !opts.method) return mockApi(path); if (e.noapi) throw new Error('Indisponível no modo demo'); throw e; }
}

// ---------- modo demo (sem back) ----------
async function mockApi(path) {
  if (!MOCK) {
    MOCK = await (await fetch('/lote1.json')).json();
    MOCK.users.forEach(u => USERS[u.username] = u);
    MOCK.posts.forEach(p => p.comments = MOCK.comments.filter(c => c.post_id === p.id).length);
  }
  const u = new URL(path, 'http://x'), P = u.searchParams;
  const kind = p => /^(pergunte|ask)/i.test(p.title) ? 'ask' : /^(mostra|show)/i.test(p.title) ? 'show' : 'news';
  if (u.pathname === '/me') return {user: null};
  if (u.pathname === '/stories') {
    const t = P.get('type') || 'news'; let l = [...MOCK.posts];
    if (t === 'ask' || t === 'show') l = l.filter(p => kind(p) === t);
    if (t === 'jobs') l = [];
    if (t === 'newest' || t === 'front') l.sort((a, b) => b.created_at.localeCompare(a.created_at));
    else l.sort((a, b) => rank(b) - rank(a));
    return {stories: l, more: false};
  }
  if (u.pathname.startsWith('/item/')) {
    const id = +u.pathname.split('/')[2];
    const post = MOCK.posts.find(p => p.id === id);
    if (post) return {post, comments: MOCK.comments.filter(c => c.post_id === id)};
    const c = MOCK.comments.find(c => c.id === id);
    if (c) return {comment: c, post: MOCK.posts.find(p => p.id === c.post_id), comments: MOCK.comments.filter(x => x.post_id === c.post_id)};
    throw Object.assign(new Error('Item não encontrado'), {api: true});
  }
  if (u.pathname.startsWith('/user/')) {
    const n = decodeURIComponent(u.pathname.split('/')[2]); const user = USERS[n];
    if (!user) throw Object.assign(new Error('Usuário não encontrado'), {api: true});
    return {user, posts: MOCK.posts.filter(p => p.author === n), comments: MOCK.comments.filter(c => c.author === n)};
  }
  if (u.pathname === '/comments') return {comments: [...MOCK.comments].sort((a, b) => b.created_at.localeCompare(a.created_at)).map(c => ({...c, post_title: MOCK.posts.find(p => p.id === c.post_id)?.title}))};
  if (u.pathname === '/search') { const q = (P.get('q') || '').toLowerCase(); return {stories: MOCK.posts.filter(p => (p.title + ' ' + p.text).toLowerCase().includes(q))}; }
  throw Object.assign(new Error('Indisponível no modo demo'), {api: true});
}
const rank = p => (p.points - 1) / Math.pow((Date.now() - new Date(p.created_at)) / 36e5 + 2, 1.8);

// ---------- helpers ----------
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  const f = (n, u, us) => `há ${n} ${n === 1 ? u : us}`;
  if (s < 3600) return f(Math.max(1, Math.floor(s / 60)), 'minuto', 'minutos');
  if (s < 86400) return f(Math.floor(s / 3600), 'hora', 'horas');
  if (s < 2592000) return f(Math.floor(s / 86400), 'dia', 'dias');
  return f(Math.floor(s / 2592000), 'mês', 'meses');
}
const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isDemo = n => (USERS[n] || {}).is_demo;
const userLink = n => `<a href="/user?id=${encodeURIComponent(n)}" class="hnuser">${esc(n)}</a>${isDemo(n) ? '<span class="demo-badge">demo</span>' : ''}`;
const fmtText = t => esc(t).split(/\n{2,}/).map(p => p.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="nofollow">$1</a>')).join('<p>');

function voteArrow(kind, id, mine) {
  if (mine || voted.has(kind + id)) return `<td valign="top" class="votelinks"><center><div style="width:14px"></div></center></td>`;
  return `<td valign="top" class="votelinks"><center><a href="#" data-vote="${kind}:${id}"><div class="votearrow" title="votar"></div></a></center></td>`;
}

function storyRows(list, start = 0) {
  return list.map((p, i) => {
    const link = p.url ? p.url : `/item?id=${p.id}`;
    const n = p.comments ?? 0;
    return `<tr class="athing submission" id="${p.id}"><td align="right" valign="top" class="title"><span class="rank">${start + i + 1}.</span></td>${voteArrow('post', p.id, ME && ME.username === p.author)}
<td class="title"><span class="titleline"><a href="${esc(link)}" ${p.url ? 'rel="nofollow"' : ''}>${esc(p.title)}</a>${p.url ? `<span class="sitebit comhead"> (<span class="sitestr">${esc(host(p.url))}</span>)</span>` : ''}</span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_${p.id}">${p.points} ${p.points === 1 ? 'ponto' : 'pontos'}</span> por ${userLink(p.author)} <span class="age" title="${esc(p.created_at)}"><a href="/item?id=${p.id}">${ago(p.created_at)}</a></span> | <a href="/item?id=${p.id}">${n === 0 ? 'discutir' : n + '&nbsp;' + (n === 1 ? 'comentário' : 'comentários')}</a></span></td></tr>
<tr class="spacer" style="height:5px"></tr>`;
  }).join('');
}

function commentTree(comments, parent = null, depth = 0) {
  return comments.filter(c => (c.parent_id ?? null) === parent).sort((a, b) => a.created_at.localeCompare(b.created_at)).map(c => `
<tr class="athing comtr" id="${c.id}"><td><table border="0"><tr><td class="ind"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" height="1" width="${depth * 40}"></td>
${voteArrow('comment', c.id, ME && ME.username === c.author)}
<td class="default"><div style="margin-top:2px;margin-bottom:-10px;"><span class="comhead">${userLink(c.author)} <span class="age" title="${esc(c.created_at)}"><a href="/item?id=${c.id}">${ago(c.created_at)}</a></span></span></div><br>
<div class="comment"><div class="commtext c00">${fmtText(c.text)}</div><div class="reply"><p><font size="1"><u><a href="/reply?id=${c.id}&post=${c.post_id}">responder</a></u></font></p></div></div></td></tr></table></td></tr>
${commentTree(comments, c.id, depth + 1)}`).join('');
}

const page = html => { $('#main').innerHTML = html; };
const errPage = e => page(`<table><tr><td class="err" style="padding:10px">${esc(e.message)}</td></tr></table>`);
const needLogin = () => { location.href = '/login?goto=' + encodeURIComponent(location.pathname + location.search); };

// ---------- paginas ----------
const titles = {news: '', newest: 'Novos', front: 'Passados', ask: 'Pergunte', show: 'Mostre', jobs: 'Vagas'};
async function listPage(type) {
  const p = +(qs.get('p') || 1);
  const d = await api(`/stories?type=${type}&p=${p}`);
  document.title = (titles[type] ? titles[type] + ' | ' : '') + 'Hacking N Robilex';
  const empty = d.stories.length ? '' : `<tr><td colspan="3" style="padding:10px" class="subtext">Nada por aqui ainda.</td></tr>`;
  page(`<table border="0" cellpadding="0" cellspacing="0">${storyRows(d.stories, (p - 1) * 30)}${empty}
<tr class="morespace" style="height:10px"></tr>${d.more ? `<tr><td colspan="2"></td><td class="title"><a href="?p=${p + 1}" class="morelink">Mais</a></td></tr>` : ''}</table>`);
}

async function itemPage() {
  const id = qs.get('id'); const d = await api('/item/' + id);
  USERS = {...USERS, ...(d.users || {})};
  if (d.comment && !d.post_only) {
    const c = d.comment; document.title = 'Comentário | Hacking N Robilex';
    page(`<table class="fatitem" border="0"><tr class="athing"><td class="default"><span class="comhead">${userLink(c.author)} <span class="age">${ago(c.created_at)}</span> | <a href="/item?id=${c.post_id}">em: ${esc(d.post?.title)}</a></span><div class="comment"><div class="commtext">${fmtText(c.text)}</div></div></td></tr>
<tr><td>${replyForm(c.post_id, c.id)}</td></tr></table><br><table border="0" class="comment-tree">${commentTree(d.comments, c.id, 0)}</table><br><br>`);
    return;
  }
  const p = d.post; p.comments = d.comments.length; document.title = p.title + ' | Hacking N Robilex';
  page(`<table class="fatitem" border="0">${storyRows([p]).replace(/<span class="rank">.*?<\/span>/, '')}
${p.text ? `<tr><td colspan="2"></td><td><div class="toptext">${fmtText(p.text)}</div></td></tr>` : ''}
<tr style="height:10px"></tr><tr><td colspan="2"></td><td>${replyForm(p.id, null)}</td></tr></table><br>
<table border="0" class="comment-tree">${commentTree(d.comments)}</table><br><br>`);
}

const replyForm = (post, parent) => `<form class="cform" data-post="${post}" data-parent="${parent ?? ''}"><textarea name="text" rows="8" cols="80" wrap="virtual"></textarea><br><br><input type="submit" value="${parent ? 'responder' : 'adicionar comentário'}"> <span class="err"></span></form>`;

async function replyPage() {
  const d = await api('/item/' + qs.get('id')); const c = d.comment || {};
  page(`<table class="fatitem" border="0"><tr><td class="default"><span class="comhead">${userLink(c.author)} <span class="age">${ago(c.created_at)}</span> | <a href="/item?id=${qs.get('post')}">voltar</a></span><div class="comment"><div class="commtext">${fmtText(c.text)}</div></div><br>${replyForm(qs.get('post'), c.id)}</td></tr></table>`);
}

async function userPage() {
  const d = await api('/user/' + encodeURIComponent(qs.get('id'))); const u = d.user; USERS[u.username] = u;
  document.title = 'Perfil: ' + u.username + ' | Hacking N Robilex';
  page(`<table border="0"><tr class="athing"><td valign="top">usuário:</td><td>${userLink(u.username)}</td></tr>
<tr><td valign="top">criado:</td><td>${new Date(u.created_at).toLocaleDateString('pt-BR', {day: 'numeric', month: 'long', year: 'numeric'})}</td></tr>
<tr><td valign="top">karma:</td><td>${u.karma ?? 0}</td></tr>
<tr><td valign="top">sobre:</td><td>${fmtText(u.about || u.bio || '')}</td></tr>
${u.is_demo ? `<tr><td></td><td class="demo-note">Este é um perfil de demonstração.</td></tr>` : ''}
<tr><td></td><td><a href="/submitted?id=${encodeURIComponent(u.username)}"><u>envios</u></a></td></tr>
<tr><td></td><td><a href="/threads?id=${encodeURIComponent(u.username)}"><u>comentários</u></a></td></tr></table><br><br>`);
}

async function submittedPage() {
  const d = await api('/user/' + encodeURIComponent(qs.get('id'))); USERS[d.user.username] = d.user;
  d.posts.forEach(p => p.comments ??= 0);
  page(`<table border="0" cellpadding="0" cellspacing="0">${storyRows(d.posts) || '<tr><td class="subtext" style="padding:10px">Nenhum envio.</td></tr>'}</table>`);
}
async function threadsPage() {
  const d = await api('/user/' + encodeURIComponent(qs.get('id'))); USERS[d.user.username] = d.user;
  page(`<table border="0">${d.comments.map(c => flatComment(c)).join('') || '<tr><td class="subtext" style="padding:10px">Nenhum comentário.</td></tr>'}</table>`);
}
const flatComment = c => `<tr class="athing"><td class="default" style="padding-bottom:12px"><span class="comhead">${userLink(c.author)} <span class="age"><a href="/item?id=${c.id}">${ago(c.created_at)}</a></span>${c.post_title ? ` | em: <a href="/item?id=${c.post_id}">${esc(c.post_title)}</a>` : ` | <a href="/item?id=${c.post_id}">post</a>`}</span><div class="comment"><div class="commtext">${fmtText(c.text)}</div></div></td></tr>`;

async function newCommentsPage() {
  const d = await api('/comments'); (d.users ? Object.assign(USERS, d.users) : 0);
  document.title = 'Comentários | Hacking N Robilex';
  page(`<table border="0">${d.comments.map(flatComment).join('')}</table>`);
}

async function searchPage() {
  const d = await api('/search?q=' + encodeURIComponent(qs.get('q') || ''));
  page(`<table border="0" cellpadding="0" cellspacing="0"><tr><td colspan="3" class="subtext" style="padding:0 0 8px 4px">Resultados para "${esc(qs.get('q'))}"</td></tr>${storyRows(d.stories) || '<tr><td colspan="3" class="subtext" style="padding:10px">Nada encontrado.</td></tr>'}</table>`);
}

function submitPage() {
  if (!ME) return needLogin();
  document.title = 'Enviar | Hacking N Robilex';
  page(`<form id="submitform"><table border="0"><tr><td>título</td><td><input type="text" name="title" size="50" maxlength="80"></td></tr>
<tr><td>url</td><td><input type="url" name="url" size="50"></td></tr>
<tr><td>texto</td><td><textarea name="text" rows="4" cols="49"></textarea></td></tr>
<tr><td></td><td><input type="submit" value="enviar"> <span class="err"></span></td></tr>
<tr style="height:20px"></tr><tr><td></td><td class="subtext">Deixe a url em branco pra enviar uma pergunta. Se tiver url, o texto é opcional.</td></tr></table></form>`);
  $('#submitform').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { const d = await api('/submit', {method: 'POST', body: JSON.stringify(Object.fromEntries(f))}); location.href = '/item?id=' + d.id; }
    catch (x) { e.target.querySelector('.err').textContent = x.message; }
  };
}

function loginPage() {
  document.title = 'Entrar | Hacking N Robilex';
  const form = (id, label, btn) => `<b>${label}</b><br><br><form id="${id}"><table border="0"><tr><td>usuário:</td><td><input type="text" name="username" size="20" autocapitalize="off"></td></tr><tr><td>senha:</td><td><input type="password" name="password" size="20"></td></tr></table><br><input type="submit" value="${btn}"> <span class="err"></span></form><br><br>`;
  page(`<div style="padding:10px">${form('loginform', 'Entrar', 'entrar')}${form('signupform', 'Criar conta', 'criar')}</div>`);
  const go = qs.get('goto') || '/news';
  for (const [id, ep] of [['loginform', '/login'], ['signupform', '/signup']])
    $('#' + id).onsubmit = async e => {
      e.preventDefault();
      try { await api(ep, {method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target)))}); location.href = go; }
      catch (x) { e.target.querySelector('.err').textContent = x.message; }
    };
}

// ---------- eventos globais ----------
document.addEventListener('click', async e => {
  const a = e.target.closest('[data-vote]'); if (!a) return;
  e.preventDefault(); if (!ME) return needLogin();
  const [kind, id] = a.dataset.vote.split(':');
  try {
    const d = await api('/vote', {method: 'POST', body: JSON.stringify({kind, id: +id})});
    voted.add(kind + id); a.closest('center').innerHTML = '<div style="width:14px"></div>';
    const s = $('#score_' + id); if (s && d.points != null) s.textContent = d.points + (d.points === 1 ? ' ponto' : ' pontos');
  } catch (x) { alert(x.message); }
});
document.addEventListener('submit', async e => {
  if (!e.target.classList.contains('cform')) return;
  e.preventDefault(); if (!ME) return needLogin();
  const f = e.target, text = f.text.value.trim(); if (!text) return;
  try { await api('/comment', {method: 'POST', body: JSON.stringify({post_id: +f.dataset.post, parent_id: f.dataset.parent ? +f.dataset.parent : null, text})}); location.href = '/item?id=' + f.dataset.post; }
  catch (x) { f.querySelector('.err').textContent = x.message; }
});
$('#search').onsubmit = e => { e.preventDefault(); location.href = '/search?q=' + encodeURIComponent(e.target.q.value); };

// ---------- roteador ----------
(async () => {
  try { const d = await api('/me'); ME = d.user; } catch { ME = null; }
  $('#auth').innerHTML = ME ? `<a href="/user?id=${encodeURIComponent(ME.username)}">${esc(ME.username)}</a> (${ME.karma ?? 0}) | <a href="#" id="logout">sair</a>` : `<a href="/login?goto=${encodeURIComponent(location.pathname + location.search)}">entrar</a>`;
  const lo = $('#logout'); if (lo) lo.onclick = async e => { e.preventDefault(); await api('/logout', {method: 'POST'}).catch(() => {}); location.href = '/news'; };
  if (!MOCK) try { const d = await api('/users'); (d.users || []).forEach(u => USERS[u.username] = u); } catch {}
  const route = location.pathname.replace(/^\/+|\/+$/g, '') || 'news';
  document.querySelectorAll('.pagetop a').forEach(a => { if (a.getAttribute('href') === '/' + route) a.style.color = '#fff', a.style.fontWeight = 'bold'; });
  const routes = {news: () => listPage('news'), newest: () => listPage('newest'), front: () => listPage('front'), ask: () => listPage('ask'), show: () => listPage('show'), jobs: () => listPage('jobs'),
    item: itemPage, reply: replyPage, user: userPage, submitted: submittedPage, threads: threadsPage, newcomments: newCommentsPage, search: searchPage, submit: submitPage, login: loginPage};
  try { await (routes[route] || (() => { throw new Error('Página não encontrada'); }))(); } catch (e) { errPage(e); }
})();
