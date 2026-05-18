// src/config.js
import { z } from 'zod';

const schema = z.object({
  MS_CLIENT_ID:             z.string().min(1),
  MS_CLIENT_SECRET:         z.string().min(1),
  MS_TENANT_ID:             z.string().default('common'),
  MS_REDIRECT_URI:          z.string().url(),
  MS_WEBHOOK_URL:           z.string().url().optional(),
  MS_WEBHOOK_CLIENT_STATE:  z.string().optional(),

  TOKEN_ENCRYPTION_KEY: z.string().min(1).refine(
    (v) => { try { return Buffer.from(v, 'base64').length === 32; } catch { return false; } },
    'TOKEN_ENCRYPTION_KEY must be 32 bytes base64-encoded'
  ),

  SUPABASE_URL:         z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  SQS_QUEUE_URL: z.string().url(),
  AWS_REGION:    z.string().default('us-east-1'),

  RESORT_ID:   z.coerce.number().int().positive().default(1),
  RESORT_NAME: z.string().default('Jackson Hole Mountain Resort'),

  DASHBOARD_BASE_URL:    z.string().url(),
  DASHBOARD_RETURN_PATH: z.string().default('/dashboard/sendy.htm'),

  NODE_ENV:  z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const env = parsed.data;

export const config = {
  microsoft: {
    clientId:    env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
    tenantId:    env.MS_TENANT_ID,
    redirectUri: env.MS_REDIRECT_URI,
    authority:   `https://login.microsoftonline.com/${env.MS_TENANT_ID}`,
    scopes: [
      'offline_access', 'openid', 'profile', 'email',
      'User.Read', 'Mail.Send', 'Mail.Read', 'Mail.ReadWrite', 'Contacts.Read',
    ],
    webhook: {
      url:         env.MS_WEBHOOK_URL,
      clientState: env.MS_WEBHOOK_CLIENT_STATE ?? 'gsb-sendy',
    },
  },
  encryption: {
    masterKey: Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64'),
  },
  supabase: {
    url:        env.SUPABASE_URL,
    serviceKey: env.SUPABASE_SERVICE_KEY,
  },
  sqs: {
    queueUrl: env.SQS_QUEUE_URL,
    region:   env.AWS_REGION,
  },
  resort: {
    id:   env.RESORT_ID,
    name: env.RESORT_NAME,
  },
  dashboard: {
    baseUrl:     env.DASHBOARD_BASE_URL,
    returnPath:  env.DASHBOARD_RETURN_PATH,
    successUrl:  () => `${env.DASHBOARD_BASE_URL}${env.DASHBOARD_RETURN_PATH}?status=connected&provider=microsoft`,
    errorUrl:    (reason) => `${env.DASHBOARD_BASE_URL}${env.DASHBOARD_RETURN_PATH}?status=error&provider=microsoft&reason=${encodeURIComponent(reason)}`,
  },
  isProd: env.NODE_ENV === 'production',
};
