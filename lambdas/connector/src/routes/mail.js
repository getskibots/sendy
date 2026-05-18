// src/routes/mail.js — Microsoft Graph webhook + outbound mail routes
//
// Key change vs. original: deliverToAgent() publishes to SQS (sendy-inbound)
// instead of being a stub. Lambda (inbound) picks it up and runs the AI pipeline.

import { Router } from 'express';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { requireAuth } from '../middleware/requireAuth.js';
import { connectionRepository } from '../db/connectionRepository.js';
import { sendMessage, listInbox, getMessage } from '../services/mail.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const router = Router();
const sqs = new SQSClient({ region: config.sqs.region });

// ---------------------------------------------------------------------------
// Middleware: resolve active MS connection for this resort
// ---------------------------------------------------------------------------
async function requireMsConnection(req, res, next) {
  const c = await connectionRepository.findByResort(req.resort.id);
  if (!c || c.status !== 'active') {
    return res.status(409).json({ error: 'no_active_microsoft_connection' });
  }
  req.connection = c;
  next();
}

// ---------------------------------------------------------------------------
// POST /api/microsoft/send
// ---------------------------------------------------------------------------
router.post('/send', requireAuth, requireMsConnection, async (req, res, next) => {
  try {
    const result = await sendMessage(req.connection, req.body);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/microsoft/messages
// ---------------------------------------------------------------------------
router.get('/messages', requireAuth, requireMsConnection, async (req, res, next) => {
  try {
    const top = Math.min(Number(req.query.limit ?? 20), 100);
    const search = req.query.q ? String(req.query.q) : undefined;
    const messages = await listInbox(req.connection, { top, search });
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/microsoft/webhook
// Microsoft Graph push notifications for new inbox messages.
// ---------------------------------------------------------------------------
router.post('/webhook', async (req, res) => {
  // Validation handshake — must echo validationToken as text/plain within 10s
  if (req.query.validationToken) {
    res.status(200).set('Content-Type', 'text/plain').send(String(req.query.validationToken));
    return;
  }

  // In Lambda, async work after res.end() is cut off when the execution context
  // freezes. Process notifications first, then ACK. Graph allows a few seconds.
  const notifications = req.body?.value ?? [];
  await Promise.all(
    notifications
      .filter((n) => {
        if (config.microsoft.webhook.clientState && n.clientState !== config.microsoft.webhook.clientState) {
          logger.warn({ clientState: n.clientState }, 'webhook clientState mismatch — ignoring');
          return false;
        }
        return true;
      })
      .map((n) =>
        handleNotification(n).catch((err) =>
          logger.error({ err: err.message, notification: n }, 'failed to process MS notification')
        )
      )
  );

  res.status(202).end();
});

async function handleNotification(notification) {
  const subscriptionId = notification.subscriptionId;
  const active = await connectionRepository.listActive();
  const connection = active.find((c) => c.subscriptionId === subscriptionId);
  if (!connection) {
    logger.warn({ subscriptionId }, 'no connection found for subscription — ignoring');
    return;
  }

  const match = /Messages\/([^/]+)$/.exec(notification.resource);
  if (!match) return;
  const messageId = match[1];

  const message = await getMessage(connection, messageId);
  await deliverToAgent(connection, message);
}

// ---------------------------------------------------------------------------
// deliverToAgent — publishes normalized email to SQS for Lambda processing
// ---------------------------------------------------------------------------
async function deliverToAgent(connection, message) {
  const payload = {
    source:      'microsoft',
    resortId:    connection.resortId,
    connectionId: connection.id,
    accountEmail: connection.accountEmail,
    message: {
      id:            message.id,
      conversationId: message.conversationId,
      rfc822MessageId: message.rfc822MessageId,
      inReplyTo:     message.inReplyTo,
      references:    message.references,
      subject:       message.subject,
      from:          message.from,
      fromName:      message.fromName,
      to:            message.to,
      receivedAt:    message.receivedAt,
      text:          message.text,
      html:          message.html,
    },
  };

  await sqs.send(new SendMessageCommand({
    QueueUrl:               config.sqs.queueUrl,
    MessageBody:            JSON.stringify(payload),
    MessageDeduplicationId: undefined, // standard queue — no dedup ID needed
  }));

  logger.info({
    connectionId: connection.id,
    messageId:    message.id,
    subject:      message.subject,
  }, 'queued inbound MS message on SQS');
}

export default router;
