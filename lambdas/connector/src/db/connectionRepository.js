// Supabase-backed connection repository.
// Table: email_connections
//
// Schema (see sql/007_email_connections.sql):
//   id                     UUID PRIMARY KEY
//   resort_id              INTEGER NOT NULL
//   provider               TEXT NOT NULL DEFAULT 'microsoft'
//   account_email          TEXT
//   ms_user_id             TEXT
//   tenant_id              TEXT
//   encrypted_tokens       TEXT NOT NULL
//   scopes                 TEXT[]
//   status                 TEXT NOT NULL DEFAULT 'active'  -- active | revoked
//   subscription_id        TEXT
//   subscription_expiration TIMESTAMPTZ
//   connected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);
const TABLE = 'email_connections';

function toRow(conn) {
  return {
    id:                      conn.id,
    resort_id:               conn.resortId,
    provider:                conn.provider ?? 'microsoft',
    account_email:           conn.accountEmail ?? null,
    ms_user_id:              conn.msUserId ?? null,
    tenant_id:               conn.tenantId ?? null,
    encrypted_tokens:        conn.encryptedTokens,
    scopes:                  conn.scopes ?? [],
    status:                  conn.status ?? 'active',
    subscription_id:         conn.subscriptionId ?? null,
    subscription_expiration: conn.subscriptionExpiration ?? null,
    connected_at:            conn.connectedAt ?? new Date().toISOString(),
    updated_at:              new Date().toISOString(),
  };
}

function fromRow(row) {
  if (!row) return null;
  return {
    id:                     row.id,
    resortId:               row.resort_id,
    provider:               row.provider,
    accountEmail:           row.account_email,
    msUserId:               row.ms_user_id,
    tenantId:               row.tenant_id,
    encryptedTokens:        row.encrypted_tokens,
    scopes:                 row.scopes,
    status:                 row.status,
    subscriptionId:         row.subscription_id,
    subscriptionExpiration: row.subscription_expiration,
    connectedAt:            row.connected_at,
    updatedAt:              row.updated_at,
  };
}

export const connectionRepository = {
  async upsert(conn) {
    const { error } = await supabase.from(TABLE).upsert(toRow(conn), { onConflict: 'id' });
    if (error) { logger.error({ err: error.message }, 'connectionRepository.upsert failed'); throw error; }
    return conn;
  },

  async findByResort(resortId) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('resort_id', resortId)
      .eq('provider', 'microsoft')
      .eq('status', 'active')
      .order('connected_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) { logger.error({ err: error.message }, 'connectionRepository.findByResort failed'); throw error; }
    return fromRow(data);
  },

  async listActive() {
    const { data, error } = await supabase.from(TABLE).select('*').eq('status', 'active');
    if (error) { logger.error({ err: error.message }, 'connectionRepository.listActive failed'); throw error; }
    return (data ?? []).map(fromRow);
  },

  async updateTokens(id, encryptedTokens) {
    const { error } = await supabase
      .from(TABLE)
      .update({ encrypted_tokens: encryptedTokens, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { logger.error({ err: error.message }, 'connectionRepository.updateTokens failed'); throw error; }
  },

  async updateSubscription(id, { subscriptionId, expiration }) {
    const { error } = await supabase
      .from(TABLE)
      .update({
        subscription_id: subscriptionId,
        subscription_expiration: expiration,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    if (error) { logger.error({ err: error.message }, 'connectionRepository.updateSubscription failed'); throw error; }
  },

  async markRevoked(id) {
    const { error } = await supabase
      .from(TABLE)
      .update({ status: 'revoked', subscription_id: null, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { logger.error({ err: error.message }, 'connectionRepository.markRevoked failed'); throw error; }
  },
};
