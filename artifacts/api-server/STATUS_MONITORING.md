# Status Page & Uptime Monitoring — BetterStack Setup

This service is instrumented for **[BetterStack](https://betterstack.com/)**
(formerly Better Uptime). BetterStack was picked over UptimeRobot because the
free tier bundles a hosted status page, cron heartbeat URLs (UptimeRobot has
none on the free tier), and on-call routing.

Nothing in this file is required for the service to run — heartbeats are
strictly opt-in via environment variables. Without the secrets set, the calls
are silent no-ops.

---

## 1. What's already in code

| Endpoint              | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/healthz`    | **Deep readiness probe.** Pings Postgres under a 2 s server-side `statement_timeout`. Returns 503 with `{ status: "degraded", checks: { db: { ok: false, latencyMs, error } } }` if the DB is unreachable. **Point BetterStack's HTTP monitor here.** |
| `GET /api/healthz/live` | Liveness only — returns 200 unconditionally. Use for k8s/ECS liveness probes; do *not* use for status-page monitoring (it can't tell you the DB is down). |
| `GET /health`         | Legacy app-level alias of `/api/healthz`, kept for old LB target groups. Same response shape.   |

Heartbeat helper: `src/lib/heartbeat.ts`. Wired into these schedulers:

| Scheduler           | Cadence  | Env var                                       |
| ------------------- | -------- | --------------------------------------------- |
| `outreach`          | 15 min   | `BETTERSTACK_HEARTBEAT_OUTREACH_URL`          |
| `recruiter_digest`  | 60 min   | `BETTERSTACK_HEARTBEAT_RECRUITER_DIGEST_URL`  |
| `trial_expiry`      | 6 h      | `BETTERSTACK_HEARTBEAT_TRIAL_EXPIRY_URL`      |
| `anti_ghost`        | 30 min   | `BETTERSTACK_HEARTBEAT_ANTI_GHOST_URL`        |

Each scheduler pings its URL after every successful tick and pings the
`/fail` suffix on a thrown exception. A missed window in BetterStack means
either the service is down or the scheduler is stuck — either way, paged.

---

## 2. BetterStack setup (one-time, ~10 min)

1. Sign up at <https://betterstack.com/uptime>. Free tier is enough for launch.
2. **Add an HTTP monitor:**
   - URL: `https://<your-prod-domain>/api/healthz`
   - Check frequency: 3 minutes
   - Expected status: 200
   - Request timeout: 5 s
   - Recovery period: 1 check
   - Region: pick whichever is closest to your deploy region.
3. **Add four heartbeat monitors** (Uptime → Heartbeats → New). For each, set
   the expected period to the scheduler cadence + a ~25% margin:

   | Name             | Period   | Grace |
   | ---------------- | -------- | ----- |
   | outreach         | 15 min   | 5 min |
   | recruiter_digest | 60 min   | 15 min |
   | trial_expiry     | 6 h      | 1 h   |
   | anti_ghost       | 30 min   | 10 min |

   Copy each heartbeat URL.
4. **Set the secrets in Replit:**
   ```
   BETTERSTACK_HEARTBEAT_OUTREACH_URL=<paste>
   BETTERSTACK_HEARTBEAT_RECRUITER_DIGEST_URL=<paste>
   BETTERSTACK_HEARTBEAT_TRIAL_EXPIRY_URL=<paste>
   BETTERSTACK_HEARTBEAT_ANTI_GHOST_URL=<paste>
   ```
   Use the env-vars panel — never check these into git.
5. **Build a status page:** BetterStack → Status pages → Create. Add the four
   heartbeats + the `/api/healthz` monitor as resources. Pick a subdomain
   (`status.<your-domain>`) or use the BetterStack-hosted one for now.
6. **On-call routing:** Add at least one email (or phone, paid tier) under
   On-call → Schedules. Attach it to every monitor and heartbeat. Test by
   pausing a monitor — you should get an alert within a minute.

---

## 3. Adding a new scheduler

```ts
import { heartbeat } from "./heartbeat";

async function tick() {
  try {
    await doWork();
    heartbeat("my_new_job");                 // success
  } catch (err) {
    logger.error({ err }, "[my-new-job] tick failed");
    heartbeat("my_new_job", "fail", err);    // /fail ping
  }
}
```

Create the matching heartbeat in BetterStack, then set
`BETTERSTACK_HEARTBEAT_MY_NEW_JOB_URL`. Until that secret exists the call is a
no-op — no errors, no crashes, just silent until you flip it on.

---

## 4. What this does *not* cover

- **Frontend (lexy / lexy-site / brochures).** Add separate HTTP monitors on
  each public URL. They have no schedulers, so no heartbeats are needed.
- **Application-layer SLOs** (e.g. "P95 candidate-add latency < 2 s"). Health
  pings only confirm reachability and that crons fire — not that they're
  doing useful work fast enough. That's a Grafana/Datadog question, out of
  scope for this pre-launch pass.
- **Stripe webhook delivery.** Stripe has its own retry + alerting; mirror
  any failed-webhook spikes in BetterStack only if you start seeing them.
