// MVP: single-tenant, inject resort from env.
// Replace this with real session auth when going multi-tenant.
import { config } from '../config.js';

export function requireAuth(req, _res, next) {
  req.resort = { id: config.resort.id, name: config.resort.name };
  req.user   = { id: 'system' };
  next();
}
