// src/routes/oauth.js
//
// Routes mounted at /api/oauth/microsoft.
//   GET  /start      → Redirect to Microsoft consent
//   GET  /callback   → Exchange code, persist, start subscription
//   POST /disconnect → Revoke locally + delete subscription
//   GET  /status     → Current connection state

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { randomToken, encrypt } from '../utils/crypto.js';
import {
  buildConsentUrl,
  exchangeCodeForTokens,
  revoke,
} from '../services/msAuth.js';
import { getProfile, createSubscription, deleteSubscription } from '../services/mail.js';
import { connectionRepository } from '../db/connectionRepository.js';
import { stateStore } from '../db/stateStore.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/oauth/microsoft/start
// ---------------------------------------------------------------------------
router.get('/start', requireAuth, async (req, res, next) => {
  try {
    const state = randomToken(24);
    await stateStore.put(state, {
      resortId: req.resort.id,
      userId: req.user.id,
      issuedAt: Date.now(),
    });

    const url = await buildConsentUrl(state);
    logger.info({ resortId: req.resort.id }, 'redirecting to Microsoft consent');
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/oauth/microsoft/callback
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    logger.warn({ error, description: error_description }, 'MS OAuth returned an error');
    return res.redirect(config.dashboard.errorUrl(String(error)));
  }
  if (!code || !state) {
    return res.redirect(config.dashboard.errorUrl('missing_code_or_state'));
  }

  try {
    const payload = await stateStore.take(String(state));
    if (!payload) {
      return res.redirect(config.dashboard.errorUrl('state_expired'));
    }

    const result = await exchangeCodeForTokens(String(code));

    // Resolve profile + Graph user ID before saving so the connection row
    // has account_email immediately (not on first send).
    const tempConnection = {
      id: randomUUID(),
      resortId: payload.resortId,
      provider: 'microsoft',
      encryptedTokens: encrypt(result.serializedCache),
      scopes: result.scopes,
      status: 'active',
      connectedAt: new Date().toISOString(),
      tenantId: result.account?.tenantId ?? null,
    };

    const profile = await getProfile(tempConnection);

    const connection = {
      ...tempConnection,
      accountEmail: profile.email,
      msUserId: profile.msUserId,
    };

    await connectionRepository.upsert(connection);

    // Best-effort subscription setup. Inbound is degraded if this fails.
    if (config.microsoft.webhook.url) {
      try {
        await createSubscription(connection);
      } catch (subErr) {
        logger.warn({ err: subErr.message, connectionId: connection.id }, 'createSubscription failed (inbound disabled)');
      }
    } else {
      logger.warn({ connectionId: connection.id }, 'MS_WEBHOOK_URL not set — skipping subscription');
    }

    return res.redirect(config.dashboard.successUrl());
  } catch (err) {
    logger.error({ err }, 'MS OAuth callback failed');
    return res.redirect(config.dashboard.errorUrl('callback_failed'));
  }
});

// ---------------------------------------------------------------------------
// POST /api/oauth/microsoft/disconnect
// ---------------------------------------------------------------------------
router.post('/disconnect', requireAuth, async (req, res, next) => {
  try {
    const c = await connectionRepository.findByResort(req.resort.id);
    if (!c || c.status !== 'active') {
      return res.status(404).json({ error: 'no active MS connection' });
    }
    await deleteSubscription(c).catch(() => {});
    await revoke(c);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/oauth/microsoft/status
// ---------------------------------------------------------------------------
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const c = await connectionRepository.findByResort(req.resort.id);
    if (!c) return res.json({ connected: false });
    res.json({
      connected: c.status === 'active',
      accountEmail: c.accountEmail,
      scopes: c.scopes,
      connectedAt: c.connectedAt,
      subscriptionExpiresAt: c.subscriptionExpiration ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
