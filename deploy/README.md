# Production deployment

Run one persistent Next.js process behind Caddy, with PostgreSQL 18/pgvector on the same Linux host. Real conversation jobs belong to that Web process. The optional Node Worker handles the existing fixture tasks; it is not a second executor for real conversation jobs.

The Linux host needs Docker Engine with Compose v2 and Node.js 24 for the thin operations script. No application dependencies or PostgreSQL installation is needed on the host. Use the direct `node scripts/deploy.mjs` commands below; server operations do not run pnpm or install the workspace.

Only Caddy publishes ports 80/443. PostgreSQL and Web are on the Compose network. Caddy issues/renews HTTPS certificates, forwards NDJSON without buffering and checks a maintenance flag for new requests. Database, certificates and backup files persist separately from application containers.

## Build on your development computer

```sh
node scripts/deploy.mjs build --tag tripquest:<commit> --platform linux/amd64
```

The multi-stage Dockerfile installs the exact lockfile and builds Web, Worker, account CLI, RAG CLI and deployment CLI without a database or real environment/profile. It retains the workspace and dependencies so runtime source resolution, migrations and CLI paths remain consistent. This favors a working first deployment over a minimal image.

`.dockerignore` excludes local secrets, model profiles, private documents, Git history, evaluation output, caches and database backups. Do not put extra private files in the source tree. Base image versions and digests are fixed in `Dockerfile` and `compose.yaml`; update them deliberately. Use a commit tag or image digest for releases, and transfer/load that exact built image to the server.

For a slow registry, a single build can override the download source without changing the lockfile:

```sh
docker build --platform linux/amd64 \
  --build-arg PNPM_REGISTRY=https://registry.npmmirror.com \
  --tag tripquest:<commit> .
```

## Prepare server configuration

Create a private directory outside the checkout, for example `/home/ubuntu/tripquest-config`. Copy `deploy/env.example` into `server.env` there and restrict it to its owner (`chmod 600`). Use an absolute file path with the deployment commands.

Fill these groups:

- Image, absolute model profile/state/backup paths, public hostname and HTTPS origin. `SITE_HOST` has no scheme or path; `BETTER_AUTH_URL` is `https://` plus that hostname. Point the DNS A record to the server and permit inbound 80/443. Limit SSH access to the deployer.
- Independent random database password and signing secrets. Each signing secret needs at least 32 bytes. The database hostname inside Compose is `postgres`; encode special characters in the URL password. The actual values stay outside Git.
- Real provider keys, profile selection and explicit `TRIPQUEST_DEPLOYMENT_MODE=invited`. This enables the existing guarded capability for a restricted deployment, not public registration or a grant of provider permission. Only place IDs/names and self-authored plans/conversation persist; other third-party details are fetched at display time.
- Per-user and site daily request limits. Production requires finite `MODEL_DAILY_LIMIT`; `0` pauses new model requests. Counts include failed provider requests and are not a monetary limit. Other existing provider limits remain in force.

The profile file is mounted read-only at `/app/agent-models.local.json`. Make it readable by the application's UID 1000, while restricting other users. Its existing format is:

```json
{
  "version": 1,
  "profiles": {
    "primary": {
      "providerId": "provider-name",
      "adapter": "chat_completions",
      "baseURL": "https://api.provider.example/v1",
      "model": "provider-model-name",
      "apiKeyEnv": "PROVIDER_API_KEY",
      "jsonMode": "json_object",
      "thinkingMode": "omit",
      "temperature": 0,
      "outputTokenLimit": 512
    }
  }
}
```

Set `AGENT_MODEL_PROFILE=primary` and add the matching credential variable to `server.env`. The existing DeepSeek mapping also supports `thinkingMode=disabled`. Changing provider/model is a profile/configuration change followed by a controlled restart. Startup checks validate the chosen profile and credential locally; they do not prove that the provider account can make a successful request.

For a fixture-only production rehearsal, use `TRIPQUEST_DEPLOYMENT_MODE=local`, keep real services disabled and provide a profile file with an empty `profiles` object. `PLANNING_TASKS_ENABLED=true` makes the release script also start the Worker; the invited template defaults to request-driven real planning without the fixture Worker.

## Check and release

From the checkout, after loading the built image:

```sh
node scripts/deploy.mjs check --env-file /home/ubuntu/tripquest-config/server.env
node scripts/deploy.mjs release --env-file /home/ubuntu/tripquest-config/server.env
node scripts/deploy.mjs status --env-file /home/ubuntu/tripquest-config/server.env
```

`check` validates Compose and the application's production configuration without paid requests. `release` verifies that the application image is already local, validates configuration, enables maintenance, starts the database if needed, drains active tasks, stops Web/Worker to finish ordinary in-flight writes, creates a backup, applies existing migrations, starts the selected image and checks readiness before reopening the site. Failures after maintenance is enabled leave the maintenance flag in place. No build runs during release.

The process uses a short maintenance window. It does not offer rolling updates, multi-instance task ownership or arbitrary checkpoint recovery. First release has no previous working application to roll back to. Later releases keep the preceding release record in the private state directory; for a compatible schema, select that image and rerun release. A database downgrade or production restore requires a separate, reviewed operation.

Initialize the owner using the built account CLI with interactive password input:

```sh
export TRIPQUEST_ENV_FILE=/home/ubuntu/tripquest-config/server.env
docker compose --env-file "$TRIPQUEST_ENV_FILE" \
  -f deploy/compose.yaml run --rm --entrypoint node ops \
  packages/auth/dist/users.js set-password owner
```

For direct Compose commands, also export `TRIPQUEST_ENV_FILE` with that same absolute path; the wrapper sets it automatically. Use the same CLI with `invite` to issue one-time invitations. The RAG entry is `packages/rag/dist/cli.js`; `ingest` uses the configured embedding provider and incurs provider charges. Owner setup and provider validation precede inviting friends.

Health endpoints are read-only: `/api/health/live` tests the process, and `/api/health/ready` checks production configuration and the shipped migration hashes against the database. Unhealthy status is diagnostic; Docker's restart policy restarts exited processes, not every unhealthy container.

## Back up and restore to a test database

```sh
node scripts/deploy.mjs backup --env-file /home/ubuntu/tripquest-config/server.env
node scripts/deploy.mjs restore-test /absolute/path/to/backup.dump \
  --database tripquest_restore_test \
  --env-file /home/ubuntu/tripquest-config/server.env
```

Schedule `backup` daily in the server's cron. The script writes custom-format `pg_dump` backups atomically with owner-only permissions, keeps seven daily copies and two pre-update copies, and does not treat a failed/empty dump as a successful backup. Keep at least one encrypted-transfer copy on another computer, together with the private environment/profile files.

`restore-test` only creates a new database ending in `_test` and refuses an existing target; it never drops or overwrites the production database. Verify the restored relationships and schema before relying on the backup. The helper deliberately does not automate production restore.

For isolated local validation, `--project` selects a separate Compose project and `--override-file` accepts an absolute Compose override file, such as one binding test ports only to loopback. The same release/backup commands are used. No production test endpoints are added.

## Resources and source entries

The initial limits are Web 768 MiB, PostgreSQL 512 MiB, Caddy 96 MiB and optional Worker 256 MiB. These limits are a configuration, not proof of target-host capacity; measure concurrent use, disk growth and actual client networks before admitting users. Build images locally and retain only the necessary releases/backups on a small server.

- Runtime opt-in boundary: `apps/web/src/app/deployment/environment.ts`.
- Startup configuration: `apps/web/src/app/deployment/config.ts`, `apps/web/src/instrumentation.ts`.
- Health and migration verification: `apps/web/src/app/deployment/health.ts`.
- Runtime operations: `apps/web/src/deployment-cli.ts`, built to `deploy/dist/cli.js`.
- Host release and backup orchestration: `scripts/deploy.mjs`.
- Shared usage accounting: `packages/db/src/usage.ts`.

## Owner cost and run view

Open **账号 → 费用与运行** with an admin account. A planning job shows its full estimate across all days, including automatic retries. Choose a day to see its contribution. The amounts come from model receipts. Other metered services show reservation counts.

To enable estimates, put the account's price list in a dedicated directory outside the checkout. Set `TRIPQUEST_COST_CONFIG_DIR` to its absolute host path and `MODEL_PRICE_FILE=/app/cost-config/prices.json`. The wrapper mounts the directory read-only in Web and the maintenance CLI. Set `MODEL_BILLING_CHANNEL` to the matching channel (default `default`). Without a matching rate the receipt stays pending reconciliation. Each array entry has the following shape. These numbers and names are fictional.

```json
[{"channel":"default","provider":"example","model":"model-version","aliases":["model-alias"],"from":"2026-01-01T00:00:00Z","currency":"CNY","hit":"0.5","miss":"2","output":"8","source":"example account rate sheet"}]
```

Rates are decimal strings per million tokens. For flat input pricing, replace both cache rates with `"input":"2"`. Keep earlier effective versions when installing a new rate. To show paid server or domain expenses, set `FIXED_EXPENSE_FILE=/app/cost-config/fixed.json`, for example `[{"type":"server","period":"2026-11","paid":"2026-11-01","currency":"CNY","amount":"20.00"}]`.

The daily backup command also clears expired billing details. Run it daily and monitor its exit status. To reconcile a smoke test, compare one authorized planning run with the supplier's account, returned model, cache counts, currency and billing-day timezone. Record differences or delayed receipts before using the estimate as a cost reference.
