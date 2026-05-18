// src/services/mail.js
//
// Microsoft Graph mail operations.
//
// Graph API differences vs Gmail API worth noting:
//   - Threading uses 'conversationId' (Microsoft's equivalent of Gmail's
//     threadId). Both can be passed back to keep replies in-thread.
//   - Send is a single Graph call with a JSON message body — much simpler
//     than Gmail's base64-MIME song and dance, BUT we lose direct control
//     over Message-ID generation. Graph assigns one; we read it from the
//     'internetMessageId' header after.
//   - Inbound notifications use Graph subscriptions (push to HTTPS webhook),
//     not Pub/Sub. Subscriptions max out at ~70h then must be renewed.

import { Client } from '@microsoft/microsoft-graph-client';
import 'isomorphic-fetch';
import { getAccessToken } from './msAuth.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { connectionRepository } from '../db/connectionRepository.js';

// ============================================================================
// Graph client factory
// ============================================================================

async function graphClient(connection) {
  return Client.init({
    authProvider: async (done) => {
      try {
        const token = await getAccessToken(connection);
        done(null, token);
      } catch (err) {
        done(err, null);
      }
    },
  });
}

// ============================================================================
// Profile
// ============================================================================

/**
 * Fetch the connected user's profile. Called immediately after OAuth to
 * resolve the account email and Graph user ID.
 */
export async function getProfile(connection) {
  const client = await graphClient(connection);
  const me = await client.api('/me').select('id,userPrincipalName,mail,displayName').get();
  return {
    msUserId: me.id,
    email: me.mail ?? me.userPrincipalName,
    displayName: me.displayName,
  };
}

// ============================================================================
// Send
// ============================================================================

/**
 * Send a message. Threading: pass conversationId from a prior message to
 * keep the reply in-thread. The Internet headers (In-Reply-To, References)
 * are added by Graph automatically when you use the reply endpoint, but for
 * a sendMail call, we set them explicitly.
 *
 * @param connection  The DB connection row
 * @param payload     { to, cc, bcc, subject, text, html, replyTo, fromName,
 *                      conversationId, inReplyTo, references }
 */
export async function sendMessage(connection, payload) {
  const client = await graphClient(connection);

  // If we have an inReplyTo, prefer the /reply endpoint — it handles
  // threading headers automatically. Otherwise use sendMail.
  if (payload.inReplyTo && payload.conversationId) {
    return sendReplyByMessageId(connection, client, payload);
  }

  const message = buildGraphMessage(connection, payload);
  await client.api('/me/sendMail').post({
    message,
    saveToSentItems: true,
  });

  // sendMail returns 202 Accepted with no body. We can't get the Message-ID
  // back synchronously. For threading, the caller should pass conversationId
  // in subsequent sends. If you need the actual Internet Message-ID, query
  // /me/messages right after with a $filter on subject + sentDateTime.

  logger.info({
    connectionId: connection.id,
    to: payload.to,
    subject: payload.subject,
  }, 'sent MS message via sendMail');

  return { accepted: true };
}

/**
 * Reply to an existing message by ID — Graph handles the threading headers.
 */
async function sendReplyByMessageId(connection, client, payload) {
  // Need to find the Graph message ID we're replying to. The Internet
  // Message-ID (from RFC 5322) is stored under internetMessageId; lookup:
  const search = await client
    .api('/me/messages')
    .filter(`internetMessageId eq '${payload.inReplyTo.replace(/'/g, "''")}'`)
    .select('id')
    .top(1)
    .get();

  if (!search.value?.length) {
    // Fallback: send as a new message that the recipient's client will likely
    // still thread via References header.
    return sendMessage(connection, { ...payload, inReplyTo: null, conversationId: null });
  }

  const graphMessageId = search.value[0].id;
  const replyBody = {
    message: buildGraphMessage(connection, payload, { isReply: true }),
    comment: '', // empty since we provide the full body
  };

  await client.api(`/me/messages/${graphMessageId}/reply`).post(replyBody);

  logger.info({
    connectionId: connection.id,
    inReplyTo: payload.inReplyTo,
  }, 'sent MS reply via /reply');

  return { accepted: true };
}

function buildGraphMessage(connection, payload, { isReply = false } = {}) {
  const fromDisplay = payload.fromName ?? null;
  const fromAddress = connection.accountEmail;

  const toArr = (v) => (Array.isArray(v) ? v : [v]).filter(Boolean);
  const recipients = (emails) =>
    toArr(emails).map((e) => ({ emailAddress: { address: e } }));

  const message = {
    subject: payload.subject,
    body: {
      contentType: payload.html ? 'html' : 'text',
      content: payload.html ?? payload.text ?? '',
    },
    toRecipients: recipients(payload.to),
  };

  if (payload.cc)      message.ccRecipients  = recipients(payload.cc);
  if (payload.bcc)     message.bccRecipients = recipients(payload.bcc);
  if (payload.replyTo) message.replyTo       = recipients(payload.replyTo);

  // Custom From identity — only honored if the user has SendAs permission.
  // For most resort mailboxes, the connected account IS the sender, so
  // Graph uses the authenticated user's address regardless of this field.
  if (fromDisplay) {
    message.from = {
      emailAddress: { address: fromAddress, name: fromDisplay },
    };
  }

  return message;
}

// ============================================================================
// Read
// ============================================================================

/**
 * List recent inbox messages.
 */
export async function listInbox(connection, { top = 20, search } = {}) {
  const client = await graphClient(connection);
  let req = client
    .api('/me/mailFolders/Inbox/messages')
    .select('id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead')
    .orderby('receivedDateTime DESC')
    .top(top);
  if (search) req = req.search(`"${search.replace(/"/g, '\\"')}"`);
  const { value } = await req.get();
  return value;
}

/**
 * Fetch one message with full body and headers.
 */
export async function getMessage(connection, messageId) {
  const client = await graphClient(connection);
  const m = await client
    .api(`/me/messages/${messageId}`)
    .select('id,conversationId,internetMessageId,internetMessageHeaders,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview')
    .get();
  return normalizeMessage(m);
}

function normalizeMessage(m) {
  const headersByName = Object.fromEntries(
    (m.internetMessageHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value])
  );
  return {
    id: m.id,
    conversationId: m.conversationId,
    rfc822MessageId: m.internetMessageId,
    inReplyTo: headersByName['in-reply-to'] ?? null,
    references: headersByName['references'] ?? null,
    subject: m.subject,
    from: m.from?.emailAddress?.address,
    fromName: m.from?.emailAddress?.name,
    to: (m.toRecipients ?? []).map((r) => r.emailAddress.address),
    cc: (m.ccRecipients ?? []).map((r) => r.emailAddress.address),
    receivedAt: m.receivedDateTime,
    text: m.body?.contentType === 'text' ? m.body.content : null,
    html: m.body?.contentType === 'html' ? m.body.content : null,
    preview: m.bodyPreview,
  };
}

// ============================================================================
// Subscriptions (push notifications)
// ============================================================================

/**
 * Create a Graph subscription so Microsoft pushes new-message notifications
 * to our webhook. Max lifetime is 4230 minutes (~70 hours).
 */
export async function createSubscription(connection) {
  if (!config.microsoft.webhook.url) {
    throw new Error('MS_WEBHOOK_URL not configured — cannot create subscription');
  }
  const client = await graphClient(connection);

  const expiration = new Date(Date.now() + 70 * 60 * 60 * 1000).toISOString();

  const sub = await client.api('/subscriptions').post({
    changeType: 'created',
    notificationUrl: config.microsoft.webhook.url,
    resource: "/me/mailFolders('Inbox')/messages",
    expirationDateTime: expiration,
    clientState: config.microsoft.webhook.clientState ?? 'gsb-default',
  });

  await connectionRepository.updateSubscription(connection.id, {
    subscriptionId: sub.id,
    expiration: sub.expirationDateTime,
  });

  logger.info({
    connectionId: connection.id,
    subscriptionId: sub.id,
    expiration: sub.expirationDateTime,
  }, 'created Graph subscription');

  return sub;
}

export async function deleteSubscription(connection) {
  if (!connection.subscriptionId) return;
  const client = await graphClient(connection);
  try {
    await client.api(`/subscriptions/${connection.subscriptionId}`).delete();
    logger.info({ connectionId: connection.id, subscriptionId: connection.subscriptionId }, 'deleted Graph subscription');
  } catch (err) {
    logger.warn({ err: err.message, connectionId: connection.id }, 'subscription delete failed (may already be gone)');
  }
}
