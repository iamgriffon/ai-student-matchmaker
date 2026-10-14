# Cloudflare target

This directory is the Cloudflare implementation on the `cloudflare` branch. On this branch, root `bun run build`, `bun run deploy` and `bun dev` target Cloudflare; the launcher installs the nested dependencies with its frozen lockfile before invoking Wrangler. The `main` branch preserves the Bun/PostgreSQL application, including English-first i18n.

## Architecture

- **Workers**: API and the existing frontend, served through the static-assets binding.
- **Prisma ORM 7 + `@prisma/adapter-d1`**: relational data in D1. The experimental Prisma 8 PostgreSQL contract is not a D1 adapter; this target has its own SQLite schema and generated client.
- **Vectorize**: student vectors with three features and pair vectors with four features, stored in separate 32-dimensional Euclidean indexes. Extra coordinates are zero padding, preserving distances and the ranker’s four inputs. D1 stores vector IDs and cohort context, not JSON arrays of vectors.
- **D1 JSON**: model artifacts and reports, validated with the existing Zod schemas. SQLite stores JSON rather than PostgreSQL `jsonb`.
- **External training**: Bun runs TensorFlow.js with a CPU backend and uploads models/reports through Wrangler. D1 tracks progress and enforces one active operation. Defaults remain one ranker, learning rate `0.001`, 80 iterations, with optional comparison. The legacy Workflow implementation is retained but the production training endpoint does not start it.
- **Shared engine**: normalization, eligibility, validation schemas and model training preserve the original semantics. The Postgres cache adapter remains separate.

Vectorize mutations are eventually consistent. Recommendation eligibility and final model ranking use the full current cohort, so an indexing delay cannot remove a valid recommendation. Versioned vector IDs, cohort namespaces, generation changes and a D1 deletion outbox prevent stale writes or delayed deletions from making old vectors current. Vectorize similarity is a candidate ordering hint; it does not replace academic balance or the learned ranking.

## Setup

Install root dependencies first (`bun install --frozen-lockfile` in the project root), because the engine and Zod schemas are shared with the PostgreSQL target. Then run from this directory:

```bash
bun install --frozen-lockfile
bun run db:generate
bun run types
```

The Wrangler CLI requires Node.js. Bun can invoke the package scripts; do not force Wrangler to run with `--bun`.

Provision the resources in your Cloudflare account:

```bash
bunx wrangler d1 create vestibulandos
bunx wrangler vectorize create vestibulandos-students --dimensions=32 --metric=euclidean
bunx wrangler vectorize create vestibulandos-pairs --dimensions=32 --metric=euclidean
```

The D1 binding in `wrangler.jsonc` already contains the supplied `vestibulandos` database ID. Keep its binding name `DB`, which the Worker expects. The Vectorize indexes must exist with the exact configured names and dimensions. Workflows are bound through the same config. Custom CPU and subrequest limits are omitted so deployment is accepted on Workers Free. This does not make TensorFlow training suitable for Free: its 10 ms CPU budget per invocation is insufficient for this workload. Inference and cohort processing may also exceed that budget. For in-Worker training, use Workers Paid and add `"limits": { "cpu_ms": 300000, "subrequests": 10000 }` to this config; otherwise training must run outside the Worker.

```bash
bun run db:migrate:local
bun run seed:local
bun run dev
```

The local Worker listens on `http://localhost:8787`. D1 is local; Vectorize bindings are remote because Vectorize has no local simulator. Local training and recommendations therefore write to the configured remote indexes. Use dedicated development indexes before doing local work against production resources.

## Deployment

```bash
bun run db:migrate:remote
bun run seed:remote
bun run build
bun run deploy
```

`build` generates the Prisma client and performs a Wrangler dry run; `deploy` publishes the Worker. Workers have no persistent `bun start` process. After deployment, Cloudflare runs the exported fetch handler and the workflow.

No Postgres reset or data migration is implicit. The seed is idempotent and inserts the existing synthetic CSV dataset. It does not overwrite students or import previous model/history records. For a data migration, export those records explicitly, validate artifacts with Zod and load them into D1 before selecting an active model.

## External training on Workers Free

The production API no longer starts TensorFlow Workflows. The training form calls `POST /api/training`, which dispatches a job to the external Bun service. The UI polls D1 for progress, model readiness and reports. The CLI remains available for manual training. TensorFlow fitting and Zod validation of full weights run in Bun. Wrangler reads the D1 snapshot and uploads validated model/report JSON directly, avoiding the Worker CPU budget. The script needs the same Cloudflare account access used for migrations; it works from a local machine or a service with Bun, Node and authenticated Wrangler.

From the repository root:

```bash
bun install --frozen-lockfile
bun install --cwd cloudflare --frozen-lockfile
bun run cloudflare:migrate:remote
bun run train:cloudflare --learning-rate 0.001 --epochs 80
```

Add `--compare-learning-rates` for the optional comparison, or `--local` to use local D1 instead of production. The default writes to **production D1**. No PostgreSQL connection is used. Training pairs are generated locally from the current student snapshot; Vectorize is not queried during fitting. Student and pair indexes continue to be maintained by the recommendation flow.

`0003_external_training.sql` installs an atomic completion trigger. It checks the captured revision/generation, selected model version and validation thresholds before replacing the active model. Rejected reports remain available; the previous model stays active. Progress is uploaded every ten iterations and at the first/final iteration; reports retain every loss value. Interrupted processes release the lock when possible; the API expires a missing heartbeat after 15 minutes.

This removes training CPU usage from Workers. Recommendation inference still runs on the Worker and must be measured separately against the Free limit; external training does not guarantee inference fits.

## Operational behavior

- A+B and B+A share one study pair. Existing pairs remain available after model deletion.
- New study pairs require an active compatible model and a current cohort snapshot. A single conditional SQL insert enforces both at write time.
- Student writes advance a database revision. Training checks this revision before training and before activation.
- Clearing training data removes pair metadata, models and reports, switches the Vectorize generation and schedules physical deletion. It preserves students and pair outcomes.
- Workflow retries cannot create duplicate model records: `(jobId, iteration)` is unique. Interrupted jobs are reconciled against workflow status when the UI polls.
- User writes commit to D1 first. Index synchronization can be retried by the next training/recommendation request.
- Training uses bounded, deterministic student-disjoint pair samples. The TensorFlow architecture remains `4 → 128 → 64 → 32 → 1`.
- Training still uses policy-generated labels, not real pair-success outcomes.

## Validation status

Prisma client generation, SQL migration generation and Wrangler binding type generation can be performed without building or deploying. A Worker build, runtime integration tests, typecheck and deployment must still be performed with explicit user authorization and configured Cloudflare resources. No remote resources are created by editing this target.

References: [Prisma D1 integration](https://www.prisma.io/docs/guides/v7/deployment/cloudflare-d1), [D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Vectorize client API](https://developers.cloudflare.com/vectorize/reference/client-api/), [Workflow CPU limits](https://developers.cloudflare.com/workflows/reference/limits/).

## Cloudflare Workers Builds (Git integration)

The production Worker name is **vestibulandos**, matching `https://vestibulandos.guusilveira.workers.dev/` and the `name` in `wrangler.jsonc`. D1 and Vectorize resource names remain `vestibulandos*`; they do not have to match the Worker name.

Select branch **cloudflare** and keep the repository root as the root directory. Configure:

- Build command: `bun run build`
- Deploy command: `bun run deploy`

The root build installs `cloudflare/` dependencies, generates the Prisma D1 client and validates the Worker bundle with a dry run. The deploy command uses `cloudflare/wrangler.jsonc`. An assets-only deployment will serve the frontend but return empty 404 responses for `/api/*`; deploy the configured `src/index.ts` Worker together with its bindings. If the dashboard currently uses `npx wrangler deploy`, replace it with `bun run deploy` so Wrangler runs from the Cloudflare package.

The old Node commands are explicit aliases: `bun run build:node`, `bun run dev:node` and `bun run deploy:node`. The `main` branch is not modified by this fix.

## Hosted training service

On the Bun server, install both packages and run:

```bash
bun install --frozen-lockfile
bun install --cwd cloudflare --frozen-lockfile
bun run training:serve
```

Configure `TRAINING_SERVICE_TOKEN` in the server's secret manager. Give the same secret to the Worker using `bunx wrangler secret put TRAINING_SERVICE_TOKEN` from `cloudflare/`; enter it through the interactive prompt, not source code or command arguments. The service also needs Wrangler authentication (`CLOUDFLARE_API_TOKEN` with D1 write access and `CLOUDFLARE_ACCOUNT_ID`, or an existing authenticated Wrangler profile). It defaults to port 3001 and listens on `0.0.0.0`; `PORT` and `TRAINING_HOST` can override these.

Configure `TRAINING_SERVICE_URL` on the Worker with the HTTPS base URL of this service. It is kept as a Worker secret so deployments preserve it; use `bunx wrangler secret put TRAINING_SERVICE_URL` from `cloudflare/`. The service URL must reach the process running this repository's `training:serve`, not an unrelated Bun application.

Protocol: authenticated `POST /training` with `{ "jobId": "UUID", "options": { "learningRate": 0.001, "epochs": 80, "compareLearningRates": false } }`; respond HTTP 202 with the same job ID immediately. `GET /health` returns HTTP 200. Training uses a subprocess, so the HTTP response does not wait for fitting. D1 creates/locks the job before dispatch; the trainer claims that ID once, writes progress/models/reports and activates the model atomically. Duplicate starts cannot fit the same job twice.

Deletion immediately clears the UI history, selection and count. Pending history requests are aborted and cannot restore deleted rows; physical Vectorize deletion continues through the durable outbox after the API response.

## Authorizing training requests

Start training with `POST /api/train?learningRate=0.001&epochs=80&compareLearningRates=false` and `Authorization: Bearer <training-access-key>`. `GET /api/train` never starts a run. The previous `POST /api/training` alias requires the same authorization.

Store the administrator key as the Worker secret `TRAINING_ADMIN_TOKEN` (`bunx wrangler secret put TRAINING_ADMIN_TOKEN` from `cloudflare/`). Keep it separate from `TRAINING_SERVICE_TOKEN`, which authenticates the Worker to the Bun service. A missing admin secret returns HTTP 503; an invalid key returns HTTP 401 before creating a job or contacting the service.

The modal does not ask for or send the administrative key. The key remains a backend secret for authorized administrative callers. Browser-initiated training requires a separately configured authenticated session or Cloudflare Access; until that authorization is connected, the protected API rejects unauthenticated starts. An environment variable embedded in frontend JavaScript would be visible to every visitor and cannot provide authorization.
