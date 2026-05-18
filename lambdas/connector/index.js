// lambdas/connector/index.js
// Lambda entry point — wraps the Express app via serverless-express.
// API Gateway routes all /api/* requests here.

import serverlessExpress from '@vendia/serverless-express';
import { app } from './src/app.js';

export const handler = serverlessExpress({ app });
