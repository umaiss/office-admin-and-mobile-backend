import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

import { AppConfigService } from './app-config.service';

/**
 * Builds the logging configuration.
 *
 * We use pino rather than `console.log` for one decisive reason: pino emits
 * **structured JSON**. A line like
 *
 *   Task 3f25 started by user 9a0c
 *
 * can only be searched with string matching. The same event as JSON
 *
 *   {"level":"info","msg":"task started","taskId":"3f25","userId":"9a0c","reqId":"..."}
 *
 * can be queried: "show me every task started by user 9a0c in the last hour".
 * Once the app is deployed, logs are the only window you have into it, and the
 * difference between grep-able text and queryable data is the difference
 * between guessing and knowing.
 */
export function buildLoggerConfig(config: AppConfigService): Params {
  const isProduction = config.isProduction;

  return {
    pinoHttp: {
      level: config.logLevel,

      // In development, pretty-print for human eyes. In production, emit raw
      // JSON so the log platform can parse it. Never pretty-print in
      // production: it is slow and it destroys machine-readability.
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },

      /**
       * Correlation id.
       *
       * Every log line produced while handling a request carries the same
       * `reqId`. When a user reports "it failed at 2pm", you take the request
       * id from the error response and retrieve every log line for that exact
       * request — across services, if there are several. Without correlation
       * ids, debugging concurrent traffic is guesswork.
       *
       * We honour an incoming `x-request-id` so a trace started by a gateway or
       * the mobile app keeps its identity here.
       */
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming = req.headers['x-request-id'];
        const id =
          (Array.isArray(incoming) ? incoming[0] : incoming) ?? randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },

      /**
       * Redaction. This list is a security control, not a tidiness preference.
       *
       * Logs get shipped to third-party platforms, read by support staff, and
       * retained for months. A password or bearer token written into a log line
       * is a credential leak that outlives the request by a long way — and it
       * will not show up in any code review of the auth module, because it
       * happens here.
       */
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.refreshToken',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },

      autoLogging: {
        // Health probes fire every few seconds. Logging them buries real
        // traffic in noise and inflates log storage costs.
        ignore: (req: IncomingMessage) => req.url?.includes('/health') ?? false,
      },

      customProps: () => ({ context: 'HTTP' }),
    },
  };
}
