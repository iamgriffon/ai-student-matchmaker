# Vestibulandos

Student matchmaking with Cloudflare Workers, D1, Vectorize and TensorFlow.js.
This directory is the single application root. There is one package, lockfile,
Prisma schema and Wrangler configuration. The previous Bun/PostgreSQL server
has been removed from this branch; its history remains in Git.

## Structure

- `src/index.ts`: Worker HTTP routes.
- `src/database.ts`, `src/models.ts`, `src/vectors.ts`: D1 and Vectorize access.
- `src/browserTraining.ts`: authenticated training jobs and model persistence.
- `src/training/browserWorker.ts`: TensorFlow execution in a browser Web Worker.
- `src/trainingWorkflow.ts`: retained for previously created Workflow instances.
- `src/training/`: batch processing, inference and SSE progress transport.
- `src/validators/`: Zod contracts for users, models and reports.
- `prisma/schema.prisma`: the sole database schema; generated client in `src/generated/prisma/`.
- `migrations/`: D1 SQL migrations.
- `dataset/`: CSV seed inputs.
- `public/`: English-first frontend and translations.
- `scripts/`: seed and optional Bun training tools.

## Commands

Run all commands from this directory:

```sh
bun install --frozen-lockfile
bun run db:generate
bun run db:migrate:local
bun run seed:local
bun dev
bun test
```

Development uses port 8787. `bun dev` applies pending local D1 migrations before starting. Run `bun run seed:local` once to populate a new local database. Vectorize bindings are configured as remote.
To apply data changes in production, use `db:migrate:remote` and `seed:remote`.
Neither is run automatically during installation or deployment.

Build: `bun run build`. Deploy: `bun run deploy`.
Cloudflare Builds should use this repository root, build command
`bun run build` and deploy command `bun run deploy`.
The `build:cloudflare` and `deploy:cloudflare` aliases remain compatible.

## Production resources

The Worker remains `vestibulandos`. The D1 binding is `DB` and Vectorize
bindings are `STUDENT_INDEX` and `PAIR_INDEX`. Their existing resource IDs and
names are preserved in `wrangler.jsonc`; moving the code does not recreate data.

Cloudflare Access protects training mutations. Configure `ACCESS_TEAM_DOMAIN`
and `ACCESS_AUD` as Worker variables. No administrator token is requested by
the frontend.

## Training

The modal calls `/api/train` to reserve a job and fetch a cohort snapshot.
TensorFlow runs in a browser Web Worker, with the same 128/64/32 architecture
and shared batch engine. Keep the page open until upload and activation finish.
Closing the page interrupts training; a heartbeat timeout releases abandoned jobs.

Defaults: learning rate 0.001, 80 iterations, batches of 64 samples.
The initiating page receives batch progress directly from the Web Worker.
Other pages track persisted progress through `/api/training/events`.
Cloudflare stores and validates artifacts/reports, without executing model fitting.
Only authenticated administrators can upload artifacts. Quality metrics are
reported by that administrator's browser; the server does not retrain to verify them.

`bun run build:browser` regenerates the checked-in browser assets under
`public/generated/`. The production build also runs this command.
The local dev launcher binds to loopback and permits same-origin local training
without Access; the production configuration does not enable that bypass.

The optional Bun commands `bun run train:cloudflare` and
`bun run training:serve` use the same model engine and D1 schema.
The service requires `TRAINING_SERVICE_TOKEN` in the local environment.
It is not a second application or database implementation.

Tests of the removed PostgreSQL adapters were retired with those adapters.
Model engine, SSE, validation and frontend tests run without database credentials.


## Docker / PostgreSQL development

```sh
docker compose up -d postgres
bun dev --local
```

This uses Bun on port 3000, PostgreSQL from `DATABASE_URL`, and pgvector for
both vector indexes. No Cloudflare bindings or account are needed.
Use `PORT=3002 bun dev --local` if another process occupies port 3000.
The launcher generates the PostgreSQL Prisma client from the same canonical
schema and applies the local migrations before starting watch mode.

The new runtime uses the `matchmaker` PostgreSQL schema. On first initialization,
existing `public.Users` records are imported; original Prisma 8 tables and data
remain untouched. Previous vectors/models/outcomes are not imported, because
their schema and cohort tracking differ. Train a model once in this local mode.
Subsequent starts preserve and use the `matchmaker` data.

Without `--local`, `bun dev` retains Wrangler with local D1 and remote Vectorize.
Production still deploys through `bun run deploy`.

Recommendation TensorFlow inference also runs in a browser Web Worker.
The server prepares eligible candidates and validates study-pair creation;
the browser ranks candidates using the active artifact. Switching students
terminates stale inference, and cached recommendations retain the existing behavior.

### Public training history and administrator actions

Keep `/training`, `/api/training` GET, and model history publicly readable.
In the Cloudflare Access application, remove the `/training` destination and keep
`/api/train` protected by the administrator email policy. Do not add a Bypass
policy for the API. The application independently verifies Access JWTs and
`ADMIN_EMAIL` for training mutations, including the legacy `/api/training` route.
Unauthenticated action buttons navigate to `/api/train?login=true`; after Access
login, that route redirects back to the public training page. The existing
loopback-only local development training bypass is preserved.
