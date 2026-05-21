/**
 * console.driver.ts — dry-run mail driver.
 *
 * Writes the rendered message to the logger instead of dispatching.
 * Default driver in dev, and the automatic fallback when Mailgun is
 * selected but MAILGUN_API_KEY / MAILGUN_DOMAIN / MAIL_FROM_ADDRESS is
 * unset (so dev never mis-configures into silence).
 */

import { logger } from '../../logger';
import type { MailDriver, MailMessage, MailSendResult } from '../mail.types';

export class ConsoleMailDriver implements MailDriver {
  readonly name = 'console';

  async send(message: MailMessage): Promise<MailSendResult> {
    const to = Array.isArray(message.to) ? message.to : [message.to];
    logger.info(
      {
        mail: {
          to: to.map((t) => t.email),
          subject: message.subject,
          tags: message.tags,
          textPreview: message.text.slice(0, 400),
          hasHtml: Boolean(message.html),
        },
      },
      '[mail:console] (dry-run) not dispatched',
    );
    return { messageId: null, driver: this.name, dispatched: false };
  }
}
