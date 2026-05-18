// Supabase-backed OAuth state store (10-minute TTL).
// Table: oauth_states
//
// Schema (see sql/007_email_connections.sql):
//   state      TEXT PRIMARY KEY
//   payload    JSONB NOT NULL
//   expires_at TIMESTAMPTZ NOT NULL
//   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const supabase = createClient(config.supabase.url, config.supabase.serviceKey);
const TABLE = 'oauth_states';
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export const stateStore = {
  async put(state, payload) {
    const expires_at = new Date(Date.now() + TTL_MS).toISOString();
    const { error } = await supabase.from(TABLE).insert({ state, payload, expires_at });
    if (error) { logger.error({ err: error.message }, 'stateStore.put failed'); throw error; }
  },

  // take() deletes the state after reading — one-time use.
  async take(state) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('state', state)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (error) { logger.error({ err: error.message }, 'stateStore.take failed'); throw error; }
    if (!data) return null;
    // Delete async, don't wait
    supabase.from(TABLE).delete().eq('state', state).then(() => {});
    return data.payload;
  },
};
