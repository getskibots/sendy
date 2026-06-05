// src/routes/admin.js
//
// Admin-only routes. These are not user-facing — they're called by
// internal automation (EventBridge Scheduler, ops scripts).
//
// All routes require Bearer auth with the ADMIN_AUTH_TOKEN env var.
//
//   POST /api/admin/renew-subscriptions
//     Iterate all active email_connections and renew/recreate
//     any whose Graph subscription is within the renewal window.
//     Designed to run every 6h via EventBridge Scheduler.

import { Router } from 'express';
import { logger } from '../utils/logger.js';
import { renewSubscription, createSubscription } from '../services/mail.js';
import { connectionRepository } from '../db/connectionRepository.js';

const router = Router();

// ---------------------------------------------------------------------------
// Auth — simple shared secret. EventBridge Scheduler passes it as a
// Bearer token in the Authorization header.
// ---------------------------------------------------------------------------
function requireAdminAuth(req, res, next) {
  const expected = process.env.ADMIN_AUTH_TOKEN;
  if (!expected) {
    logger.error('ADMIN_AUTH_TOKEN env var not set — admin routes disabled');
    return res.status(500).json({ error: 'admin_not_configured' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

router.use(requireAdminAuth);

// ---------------------------------------------------------------------------
// POST /api/admin/renew-subscriptions
//
// Body (optional): { windowHours?: number }   default 24
//
// Logic:
//   1. Load all active connections.
//   2. Filter to those whose subscription_expiration is within the renewal
//      window (now + windowHours), OR who have no subscription at all.
//   3. For each one:
//        - if no subscription_id   → createSubscription()
//        - else                    → renewSubscription()
//          (which PATCHes and falls back to createSubscription on 404)
//   4. Return per-connection results so logs are actionable.
//
// Returns { renewed, created, failed, skipped, windowHours, results }.
// ---------------------------------------------------------------------------
router.post('/renew-subscriptions', async (req, res, next) => {
  try {
    const windowHours = Number(req.body?.windowHours ?? 24);
    if (!Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 70) {
      return res.status(400).json({
        error: 'windowHours must be between 1 and 70',
      });
    }
    const renewalDeadline = new Date(Date.now() + windowHours * 60 * 60 * 1000);

    const allActive = await connectionRepository.listActive();
    const needAttention = allActive.filter((c) => {
      // No subscription at all → needs creation
      if (!c.subscriptionId) return true;
      // No expiration recorded → treat as needing renewal
      if (!c.subscriptionExpiration) return true;
      // Within the renewal window
      return new Date(c.subscriptionExpiration) < renewalDeadline;
    });

    logger.info({
      total: allActive.length,
      needAttention: needAttention.length,
      windowHours,
    }, 'subscription renewal scan');

    const results = [];
    let renewed = 0;
    let created = 0;
    let failed = 0;

    for (const conn of needAttention) {
      try {
        if (!conn.subscriptionId) {
          // No subscription yet — initial creation. Skips silently if
          // MS_WEBHOOK_URL isn't configured (createSubscription throws).
          await createSubscription(conn);
          created++;
          results.push({
            id: conn.id,
            accountEmail: conn.accountEmail,
            outcome: 'created',
          });
        } else {
          // Patch the existing one; renewSubscription auto-falls-back to
          // createSubscription if Graph returns 404 (subscription gone).
          await renewSubscription(conn);
          renewed++;
          results.push({
            id: conn.id,
            accountEmail: conn.accountEmail,
            outcome: 'renewed',
          });
        }
      } catch (err) {
        failed++;
        results.push({
          id: conn.id,
          accountEmail: conn.accountEmail,
          outcome: 'failed',
          error: err.message,
        });
        logger.error({
          err: err.message,
          connectionId: conn.id,
        }, 'subscription renewal failed');
      }
    }

    res.json({
      renewed,
      created,
      failed,
      skipped: allActive.length - needAttention.length,
      windowHours,
      results,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
