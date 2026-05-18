// lambdas/connector/index.js
// Lambda entry point — wraps the Express app via serverless-express.
// API Gateway routes all /api/* requests here.
// EventBridge scheduled events bypass Express and run the subscription renewal cron.

import serverlessExpress from '@vendia/serverless-express';
import { app } from './src/app.js';
import { connectionRepository } from './src/db/connectionRepository.js';
import { renewSubscription } from './src/services/mail.js';
import { logger } from './src/utils/logger.js';

const httpHandler = serverlessExpress({ app });

export const handler = async (event, context) => {
  // EventBridge scheduled event — renew all active MS Graph subscriptions
  if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
    logger.info('EventBridge cron: renewing MS Graph subscriptions');

    const active = await connectionRepository.listActive();
    const withSub = active.filter((c) => c.subscriptionId);

    logger.info({ total: active.length, withSubscription: withSub.length }, 'connections found');

    const results = await Promise.allSettled(withSub.map((c) => renewSubscription(c)));

    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.error(
          { err: r.reason?.message, connectionId: withSub[i].id },
          'subscription renewal failed'
        );
      }
    });

    const renewed = results.filter((r) => r.status === 'fulfilled').length;
    const failed  = results.filter((r) => r.status === 'rejected').length;

    logger.info({ renewed, failed }, 'subscription renewal cron complete');
    return { renewed, failed };
  }

  // HTTP event — pass to Express app
  return httpHandler(event, context);
};
