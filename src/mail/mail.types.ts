/**
 * mail.types.ts — Transport-agnostic mail types.
 *
 * Drivers (Mailgun, console, future SMTP/SES/...) all implement MailDriver.
 * The calling code never depends on a specific provider.
 */

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  to: MailAddress | MailAddress[];
  from?: MailAddress; // defaults to MAIL_FROM_ADDRESS / MAIL_FROM_NAME
  replyTo?: MailAddress;
  subject: string;
  text: string;       // plain-text fallback (required — every driver should have it)
  html?: string;      // optional HTML body
  /**
   * Freeform metadata captured in logs + audit trails. Drivers that support
   * categories / custom args (e.g. Mailgun o:tag / v:<k>) forward these as tags.
   */
  tags?: Record<string, string>;
}

export interface MailSendResult {
  /** Driver-reported message id, if available. `null` for dry-run. */
  messageId: string | null;
  driver: string;
  /** True when the driver actually dispatched. False in dry-run. */
  dispatched: boolean;
}

export interface MailDriver {
  readonly name: string;
  send(message: MailMessage): Promise<MailSendResult>;
}
