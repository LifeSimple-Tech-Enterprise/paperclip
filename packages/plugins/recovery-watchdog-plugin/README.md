# recovery-watchdog-plugin

A Paperclip plugin that detects heartbeat runs silent for more than one hour whose issue is a blocker of a parent in `status=blocked`, then creates an explicit recovery task if none already exists.

## How it works

Every 5 minutes (`*/5 * * * *`) the cron job `check-stale-blocked-parents` runs:

1. Queries `heartbeat_runs` for rows in `status='running'` where the last activity timestamp is ≥ 1 hour ago.
2. For each company with stale runs, lists all issues in `status='blocked'`.
3. For each blocked parent, reads its `blockedBy` relations and checks whether any blocker is one of the stale-run issues.
4. Creates a recovery issue assigned to the first invokable manager/creator/executive, with a dedup fingerprint so only one recovery issue is created per `(parent, blocker)` pair.

## Installing into a Paperclip company

### 1. Build the plugin

```bash
pnpm install
pnpm build
```

This produces `dist/worker.js` and `dist/manifest.js`.

### 2. Register the plugin with your Paperclip instance

Use the Paperclip plugin install API or the admin UI to upload the built package. The plugin requires no instance configuration — it is multi-tenant and discovers companies from the stale-run query.

```bash
# Example using the Paperclip CLI (adjust URL and token)
curl -X POST https://<your-paperclip-host>/api/plugins \
  -H "Authorization: Bearer $TOKEN" \
  -F "manifest=@dist/manifest.js" \
  -F "worker=@dist/worker.js"
```

### 3. Activate for your company

In the Paperclip admin UI, navigate to **Plugins → Recovery Watchdog** and enable it for your company. No additional configuration fields are required.

### 4. Verify

Check the plugin health dashboard. After the first `*/5` cron tick you should see a log entry from `recovery-watchdog: tick`.

## Capabilities required

| Capability | Purpose |
|---|---|
| `issues.read` | List blocked parent issues |
| `issues.create` | Create recovery tasks |
| `issue.relations.read` | Read blocker relationships |
| `agents.read` | Resolve recovery-task owner |
| `jobs.schedule` | Register the 5-minute cron |
| `database.namespace.read` | Query `heartbeat_runs` core table |

## Development

```bash
pnpm test        # run unit tests (placeholder stubs — QA_Unit fills bodies)
pnpm typecheck   # TypeScript type-check without emit
pnpm build       # produce dist/worker.js and dist/manifest.js
```
