/**
 * mail.service.ts — Public mail API.
 *
 * Callers never instantiate drivers directly. They import `mail` from
 * `src/mail` and call `mail.send(...)`. Driver choice is env-driven:
 *
 *   MAIL_DRIVER=console   → ConsoleMailDriver (dry-run; logs the message)
 *   MAIL_DRIVER=mailgun   → MailgunMailDriver (requires MAILGUN_API_KEY +
 *                           MAILGUN_DOMAIN + MAIL_FROM_ADDRESS)
 *
 * If 'mailgun' is selected without the required config, the service falls
 * back to the console driver with a warning — dev environments never fail
 * silently.
 */

import { config } from '../config';
import { logger } from '../logger';
import { ConsoleMailDriver } from './drivers/console.driver';
import { MailgunMailDriver } from './drivers/mailgun.driver';
import type { MailAddress, MailDriver, MailMessage, MailSendResult } from './mail.types';

function resolveDefaultFrom(): MailAddress | null {
  if (!config.MAIL_FROM_ADDRESS) return null;
  return { email: config.MAIL_FROM_ADDRESS, name: config.MAIL_FROM_NAME };
}

function createDriver(): MailDriver {
  if (config.MAIL_DRIVER === 'mailgun') {
    const from = resolveDefaultFrom();
    if (!config.MAILGUN_API_KEY || !config.MAILGUN_DOMAIN || !from) {
      logger.warn(
        {
          hasApiKey: Boolean(config.MAILGUN_API_KEY),
          hasDomain: Boolean(config.MAILGUN_DOMAIN),
          hasFrom: Boolean(from),
        },
        '[mail] MAIL_DRIVER=mailgun but MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_FROM_ADDRESS missing — falling back to console driver',
      );
      return new ConsoleMailDriver();
    }
    return new MailgunMailDriver(
      config.MAILGUN_API_KEY,
      config.MAILGUN_DOMAIN,
      from,
      config.MAILGUN_REGION,
    );
  }
  return new ConsoleMailDriver();
}

class MailService {
  private readonly driver: MailDriver;
  private readonly defaultFrom: MailAddress | null;

  constructor() {
    this.driver = createDriver();
    this.defaultFrom = resolveDefaultFrom();
    logger.info({ driver: this.driver.name, from: this.defaultFrom?.email }, '[mail] initialized');
  }

  get driverName(): string {
    return this.driver.name;
  }

  /**
   * Send an email. Throws on driver-level dispatch failure.
   * In dry-run mode (console driver), returns { dispatched: false }.
   */
  async send(message: MailMessage): Promise<MailSendResult> {
    const prepared: MailMessage =
      message.from || !this.defaultFrom
        ? message
        : { ...message, from: this.defaultFrom };
    return this.driver.send(prepared);
  }
}

export const mail = new MailService();
export type { MailMessage, MailSendResult, MailAddress } from './mail.types';
