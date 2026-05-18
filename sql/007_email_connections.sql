-- Migration 007: email_connections + oauth_states tables
-- Supports Microsoft Graph (and future Gmail) OAuth connector

CREATE TABLE IF NOT EXISTS email_connections (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resort_id               INTEGER     NOT NULL,
  provider                TEXT        NOT NULL DEFAULT 'microsoft',
  account_email           TEXT,
  ms_user_id              TEXT,
  tenant_id               TEXT,
  encrypted_tokens        TEXT        NOT NULL,
  scopes                  TEXT[]      NOT NULL DEFAULT '{}',
  status                  TEXT        NOT NULL DEFAULT 'active',  -- active | revoked
  subscription_id         TEXT,
  subscription_expiration TIMESTAMPTZ,
  connected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_connections_resort
  ON email_connections (resort_id, provider, status);

CREATE INDEX IF NOT EXISTS idx_email_connections_subscription
  ON email_connections (subscription_id)
  WHERE subscription_id IS NOT NULL;

-- Short-lived OAuth state tokens (10-minute TTL)
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT        PRIMARY KEY,
  payload    JSONB       NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional: auto-clean expired states (requires pg_cron or manual cleanup)
-- DELETE FROM oauth_states WHERE expires_at < NOW();
