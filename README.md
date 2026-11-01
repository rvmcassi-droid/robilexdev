# Hacking N Robilex

Clone do Hacker News: front estático em `public/`, API Node em `server.mjs` (contrato em `API.md`).

- `npm install && npm start` (porta em `PORT`, padrão 3000)
- Com `DATABASE_URL` usa Postgres (`pg`); sem ela usa SQLite local em `data/robilex.db` (Node 22.13+/24).
- SSL do Postgres: automático para URLs externas do Render (`*.render.com`) ou `sslmode=` na URL; force com `DATABASE_SSL=true|false`.
- Na primeira subida, com a tabela `users` vazia, importa `seed/lote1.json` (perfis de demonstração).
- Deploy: `render.yaml` (web `robilexdev` + Postgres grátis, região oregon).
