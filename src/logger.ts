/**
 * logger.ts — pino instance shared across the Job. Mirrors the GUB
 * convention: prod + GCP → structured-with-severity-mapping for Cloud
 * Logging; prod elsewhere → plain JSON; dev → pretty.
 */
import pino from 'pino';

const level = process.env['LOG_LEVEL'] ?? 'info';
const nodeEnv = process.env['NODE_ENV'];
const isGcp = Boolean(process.env['GCP_PROJECT_ID']);
const isProduction = nodeEnv === 'production';
// Cloud Run sets CLOUD_RUN_JOB (jobs) / K_SERVICE (services). A deployed
// runtime must log structured JSON regardless of NODE_ENV — gating on
// NODE_ENV alone made pretty ANSI logs possible on Cloud Run (the exact
// bug gcp-universal-backend hit on its dev service).
const onCloudRun = Boolean(process.env['CLOUD_RUN_JOB'] ?? process.env['K_SERVICE']);

export const logger = onCloudRun || (isProduction && isGcp)
  ? pino({
      level,
      messageKey: 'message',
      formatters: {
        level(label: string) {
          const severityMap: Record<string, string> = {
            trace: 'DEBUG',
            debug: 'DEBUG',
            info: 'INFO',
            warn: 'WARNING',
            error: 'ERROR',
            fatal: 'CRITICAL',
          };
          return { severity: severityMap[label] ?? 'DEFAULT' };
        },
      },
    })
  : isProduction
    ? pino({ level })
    : pino({
        level,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      });
