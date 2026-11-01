# Contrato da API (front do Hacking N Robilex)
O front é estático (index.html, app.js, news.css, logo.svg). O back deve servir esses arquivos e devolver index.html em qualquer rota que não seja /api nem arquivo (news, newest, front, ask, show, jobs, item, reply, user, submitted, threads, newcomments, search, submit, login).
Sessão por cookie. Erros: status != 2xx com {"error": "mensagem em pt-BR"}.

GET  /api/me                     -> {user: {username, karma, is_demo} | null}
GET  /api/users                  -> {users: [{username, is_demo, karma, about, created_at}]}   (usado pro selo demo)
GET  /api/stories?type=news|newest|front|ask|show|jobs&p=1  -> {stories: [post], more: bool}   (30 por página; news = ranking por pontos/idade)
GET  /api/item/:id               -> post: {post, comments: [comment]}  |  comentário: {comment, post, comments: [todos do post]}
GET  /api/user/:username         -> {user, posts: [post], comments: [comment com post_title]}
GET  /api/comments               -> {comments: [comment com post_title]}  (mais recentes primeiro)
GET  /api/search?q=              -> {stories: [post]}
POST /api/signup {username,password}  POST /api/login {username,password}  POST /api/logout
POST /api/submit {title,url,text}     -> {id}
POST /api/vote {kind: "post"|"comment", id} -> {points}
POST /api/comment {post_id, parent_id|null, text} -> {id}

post = {id, author, title, url, text, points, comments (contagem), created_at}
comment = {id, post_id, parent_id, author, text, points, created_at}
Sem a API, o front cai num modo demo somente leitura usando /lote1.json.
