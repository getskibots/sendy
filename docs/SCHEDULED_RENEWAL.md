# Scheduled Subscription Renewal

Microsoft Graph subscriptions for inbox change-notifications max out at
**4230 minutes (~70 hours)**. Past that, Graph silently stops sending
webhooks — your OAuth tokens are still valid, the UI says "Connected,"
but nothing comes in. The fix is to renew subscriptions on a schedule
before they expire.

This doc covers the connector-side endpoint we ship plus the AWS setup
to call it on a cron.

---

## What ships with the connector

`POST /api/admin/renew-subscriptions`

- Auth: `Authorization: Bearer <ADMIN_AUTH_TOKEN>`
- Body (optional): `{ "windowHours": 24 }` — renews any subscription
  expiring within this window. Default 24.
- Returns: per-connection results with counts.

Internally it:

1. Loads all `email_connections` rows where `status = 'active'`.
2. Filters to those with no subscription OR with `subscription_expiration <
   now + windowHours`.
3. For each:
   - No `subscription_id` → `createSubscription()` (initial setup)
   - Has `subscription_id` → `renewSubscription()` (PATCH; falls back to
     create on 404)
4. Writes new `subscription_id` + `subscription_expiration` back to the
   `email_connections` row.

The endpoint is idempotent and safe to call repeatedly — subscriptions
that don't need renewing are skipped.

---

## Setup (do this once)

### 1. Generate and configure the admin token

Pick a strong random string (32+ chars). On macOS/Linux:

```bash
openssl rand -hex 32
```

Add it as a Lambda environment variable on the **connector** Lambda
(the one serving `kpz4fvcdle.execute-api.us-east-1.amazonaws.com`):

```
ADMIN_AUTH_TOKEN = <the random string>
```

Save. Lambda picks up env changes on the next invocation.

### 2. Verify the endpoint works

```bash
curl -X POST \
  https://kpz4fvcdle.execute-api.us-east-1.amazonaws.com/api/admin/renew-subscriptions \
  -H "Authorization: Bearer <the same random string>" \
  -H "Content-Type: application/json" \
  -d '{"windowHours": 70}'
```

(Setting `windowHours: 70` forces ALL active connections to renew
right now — useful for a first-run sanity check.)

You should get back JSON like:

```json
{
  "renewed": 1,
  "created": 0,
  "failed": 0,
  "skipped": 0,
  "windowHours": 70,
  "results": [
    { "id": "...", "accountEmail": "support@demoresort.com", "outcome": "renewed" }
  ]
}
```

Then check `email_connections.subscription_expiration` in Supabase —
it should now be ~70h in the future.

### 3. Schedule it on EventBridge

Open the AWS Console → EventBridge → **Scheduler** → **Schedules** →
**Create schedule**.

**Schedule details:**

- Name: `sendy-renew-subscriptions`
- Description: `Renew Graph mail subscriptions before 70h expiry`
- Schedule pattern: **Recurring schedule**
- Schedule type: **Cron-based schedule**
- Cron expression: `cron(0 0/6 * * ? *)` (every 6 hours at minute 0)
- Timezone: UTC (doesn't matter — interval-based)
- Flexible time window: Off

**Target:**

- Target API: **API destination**
- API destination: **Create new API destination**
  - Name: `sendy-connector`
  - API destination endpoint: `https://kpz4fvcdle.execute-api.us-east-1.amazonaws.com/api/admin/renew-subscriptions`
  - HTTP method: `POST`
  - Invocation rate limit per second: 1 (plenty for 6h cron)
  - Connection: **Create new connection**
    - Name: `sendy-connector-bearer`
    - Authorization type: **API key**
    - API key name: `Authorization`
    - Value: `Bearer <the same ADMIN_AUTH_TOKEN you set on the Lambda>`

**Payload:**

```json
{ "windowHours": 24 }
```

**Settings:**

- Action after schedule completion: NONE
- Retry policy: Maximum age 1 hour, Retry attempts 3
- Dead-letter queue: optional but recommended (point at a new SQS DLQ
  so failures are visible)

Click **Create schedule**.

### 4. Watch the first run

EventBridge will fire it on the next 6-hour boundary. To verify it's
firing without waiting, click **Edit** on the schedule and check the
"Last run" timestamp once it shows up.

CloudWatch logs for the connector Lambda will show:

```
INFO subscription renewal scan { total: 1, needAttention: 1, windowHours: 24 }
INFO renewed Graph subscription { connectionId, subscriptionId, expiration }
```

---

## Operational notes

- **Renewal cadence:** every 6h with a 24h window means each subscription
  gets renewed ~4 times in its 70h lifetime. Generous safety margin —
  even if 3 consecutive runs fail, the next one still beats expiry.
- **What "failed" means:** the Lambda returned `failed > 0`. Common
  causes: refresh token rotated and we missed it (the connection is
  effectively dead — needs human reconnect), Graph API outage, mailbox
  permissions revoked. Each failure is logged with `connectionId` so
  you can `connectionRepository.markRevoked(id)` manually if needed.
- **First connection still requires** the user to click Connect Outlook
  in omni-odin. This scheduler only renews existing subscriptions.
- **Multi-tenant safe:** the endpoint iterates ALL active connections
  regardless of `resort_id`, so it works fine once you have 30 resorts
  connected.

---

## Rollback

If something goes wrong:

1. Disable the EventBridge schedule (don't delete — just toggle off).
2. The connector still works normally; only the auto-renewal stops.
3. Manual reconnect via omni-odin Settings → Channels → Email
   restores any individual connection.

To remove entirely:

1. Delete the EventBridge schedule.
2. Unset `ADMIN_AUTH_TOKEN` on the Lambda env (admin routes will then
   return 500 by design, so no one can hit them accidentally).
3. Optionally remove `src/routes/admin.js` and the `app.use('/api/admin')`
   line in `app.js`.
