// src/app.js — Express app wired up for Lambda

import express from 'express';
import oauthRoutes from './routes/oauth.js';
import mailRoutes from './routes/mail.js';
import { logger } from './utils/logger.js';

export const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Microsoft OAuth flow
app.use('/api/oauth/microsoft', oauthRoutes);

// Microsoft mail + webhook
app.use('/api/microsoft', mailRoutes);

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});
