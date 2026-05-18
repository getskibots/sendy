// src/services/msAuth.js
//
// Microsoft Authentication Library (MSAL) Node wrapper.
//
// Key differences from Google's OAuth library:
//   1. MSAL maintains its own internal "token cache" that we serialize as
//      JSON and store encrypted. Refreshes happen inside MSAL — we just
//      re-serialize after each operation.
//   2. The token cache contains BOTH access and refresh tokens plus account
//      metadata. We persist the whole cache, not just refresh_token.
//   3. To make an authenticated Graph call: acquireTokenSilent() from the
//      cache, which auto-refreshes if expired.

import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from '../config.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { connectionRepository } from '../db/connectionRepository.js';
import { logger } from '../utils/logger.js';

/**
 * Build a fresh MSAL client with NO cache loaded. Used for the initial
 * authorization URL generation and for handling the OAuth callback.
 */
function freshClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      clientSecret: config.microsoft.clientSecret,
      authority: config.microsoft.authority,
    },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => logger.debug({ msal: message }),
        piiLoggingEnabled: false,
        logLevel: 3, // Info
      },
    },
  });
}

/**
 * Build a client whose cache is pre-loaded from a connection's encrypted blob.
 * Use this for any operation against an existing connection — sending mail,
 * reading mail, managing subscriptions, etc.
 */
async function clientForConnection(connection) {
  if (!connection?.encryptedTokens) {
    throw new Error('connection has no stored tokens');
  }

  const client = freshClient();
  const cache = client.getTokenCache();
  await cache.deserialize(decrypt(connection.encryptedTokens));
  return client;
}

/**
 * Build the consent URL.
 */
export async function buildConsentUrl(state) {
  const client = freshClient();
  return client.getAuthCodeUrl({
    scopes: config.microsoft.scopes,
    redirectUri: config.microsoft.redirectUri,
    state,
    // 'select_account' shows the account chooser even if the user is already
    // signed in to a Microsoft account — important for users with multiple
    // tenants (work + personal).
    prompt: 'select_account',
  });
}

/**
 * Exchange the auth code from the OAuth callback for tokens.
 * Returns { tokens, serializedCache } — the cache is what we persist.
 */
export async function exchangeCodeForTokens(code) {
  const client = freshClient();
  const result = await client.acquireTokenByCode({
    scopes: config.microsoft.scopes,
    code,
    redirectUri: config.microsoft.redirectUri,
  });

  // Serialize the cache so we can store + reload it later.
  const serializedCache = await client.getTokenCache().serialize();

  return {
    accessToken: result.accessToken,
    account: result.account, // { homeAccountId, environment, tenantId, username, ... }
    scopes: result.scopes,
    expiresOn: result.expiresOn,
    serializedCache,
  };
}

/**
 * Acquire a fresh access token for an existing connection. Uses MSAL's
 * silent flow — it returns the cached access token if still valid, otherwise
 * uses the refresh token to get a new one.
 *
 * After every call, we re-serialize the cache and persist it (the refresh
 * may have rotated tokens).
 */
export async function getAccessToken(connection) {
  const client = await clientForConnection(connection);
  const cache = client.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) {
    throw new Error('no accounts in token cache — re-consent required');
  }

  const result = await client.acquireTokenSilent({
    account: accounts[0],
    scopes: config.microsoft.scopes,
  });

  // Persist any updated cache state.
  const newCache = await cache.serialize();
  if (newCache !== decrypt(connection.encryptedTokens)) {
    await connectionRepository.updateTokens(connection.id, encrypt(newCache));
    logger.info({ connectionId: connection.id }, 'refreshed and persisted MS tokens');
  }

  return result.accessToken;
}

/**
 * Revoke the connection. Microsoft doesn't expose a hosted revocation
 * endpoint the same way Google does, so we clear our local state and the
 * user can revoke at https://myaccount.microsoft.com/consent if they want.
 */
export async function revoke(connection) {
  await connectionRepository.markRevoked(connection.id);
  logger.info({ connectionId: connection.id }, 'revoked MS connection locally');
  // Note: Microsoft tokens stay valid until they expire naturally (~1h for
  // access, ~90 days for refresh). The user can manually revoke at
  // https://myaccount.microsoft.com/consent
}
