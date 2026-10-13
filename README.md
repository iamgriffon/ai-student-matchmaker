# ai-postgrad

## PostgreSQL local

The local database runs in Docker Compose and is configured through `.env`.

```bash
cp .env.example .env
docker compose up -d
bun install
bun run db:init
bun run dev
```

The app connects to `localhost:5432` using `DATABASE_URL`. To stop PostgreSQL and preserve its data, run:

```bash
docker compose down
```

To delete the local database and its stored data as well, run:

```bash
docker compose down -v
```

## Produção

Execute os comandos na pasta `projeto-vestibulandos`:

```bash
bun install --frozen-lockfile
bun run build:node
bun start
```

No serviço de deploy, para o alvo Node, configure `bun run build:node` como comando de build e `bun start` como comando de inicialização. O ambiente precisa ter Bun instalado e `DATABASE_URL` apontando para um PostgreSQL com pgvector e as migrações do projeto aplicadas. `PORT` é opcional e usa `3000` por padrão.

O build inclui `dist/server.mjs`, `dist/trainMatchmaking.mjs` e `dist/public/`. O servidor usa os arquivos compilados, com `NODE_ENV=production` e sem watch. O treinamento iniciado pelo frontend também executa o worker compilado.

Modelos, relatórios e vetores permanecem no PostgreSQL. Iniciar o servidor não recria nem limpa o banco.

## Treinamento

O treinamento padrão gera um modelo com taxa de aprendizado `0.001`:

```bash
bun run train:matchmaking
```

Para comparar `0.01` e `0.001`, gerando dois modelos:

```bash
bun run train:matchmaking:compare
```

No frontend, **Treinar modelo** abre um formulário com taxa de aprendizado `0.001` e `80` iterações como padrão. A opção de comparar também com `0.01` fica desmarcada. O modelo com a taxa informada no formulário é ativado se passar pela validação.

Os mesmos parâmetros podem ser informados pela CLI:

```bash
bun run train:matchmaking --learning-rate 0.002 --epochs 100
```

## Languages

The frontend defaults to English (`en-US`). The main menu offers Portuguese (`pt-BR`), with the selection persisted in browser storage. Translation catalogs are in `public/locales/`; `public/i18n.js` translates static and dynamically rendered text, accessible labels and placeholders. Dates and numbers follow the chosen locale; currency remains BRL.

## Cloudflare branch

On branch `cloudflare`, the Workers/D1/Vectorize target lives in [cloudflare/](cloudflare/README.md). On this branch, `bun dev`, `bun run build` and `bun run deploy` target Cloudflare and install its nested dependencies automatically. The PostgreSQL target remains available with `bun run dev:node` and `bun run build:node`. Configure the resources and apply the D1 migrations before starting it.
