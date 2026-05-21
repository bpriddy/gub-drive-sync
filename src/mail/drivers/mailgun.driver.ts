/**
 * mailgun.driver.ts — Mailgun transport via the v3 Messages HTTP API.
 *
 * Endpoint: POST https://api.{region}.mailgun.net/v3/{domain}/messages
 *   - US region → api.mailgun.net
 *   - EU region → api.eu.mailgun.net
 *
 * Auth: HTTP Basic with username="api", password=MAILGUN_API_KEY.
 *
 * Body: application/x-www-form-urlencoded. No multipart (we don't carry
 * attachments). Multiple recipients are sent as repeated "to" fields
 * (Mailgun accepts repeated fields and a comma-joined string; repeated
 * is safer against names that contain commas).
 *
 * No SDK dependency — `fetch` directly, to keep the image lean.
 */

import { logger } from '../../logger';
import type { MailAddress, MailDriver, MailMessage, MailSendResult } from '../mail.types';

export type MailgunRegion = 'us' | 'eu';

function regionHost(region: MailgunRegion): string {
  return region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
}

function formatAddress(addr: MailAddress): string {
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

interface MailgunSuccessBody {
  id?: string;
  message?: string;
}

interface MailgunErrorBody {
  message?: string;
}

export class MailgunMailDriver implements MailDriver {
  readonly name = 'mailgun';
  private readonly endpoint: string;
  private readonly authHeader: string;

  constructor(
    apiKey: string,
    domain: string,
    private readonly defaultFrom: MailAddress,
    region: MailgunRegion = 'us',
  ) {
    this.endpoint = `https://${regionHost(region)}/v3/${encodeURIComponent(domain)}/messages`;
    this.authHeader = `Basic ${Buffer.from(`api:${apiKey}`).toString('base64')}`;
  }

  async send(message: MailMessage): Promise<MailSendResult> {
    const from = message.from ?? this.defaultFrom;
    if (!from?.email) {
      throw new Error(
        'mailgun.send: no `from` address available — set MAIL_FROM_ADDRESS or pass message.from',
      );
    }

    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    if (recipients.length === 0) {
      throw new Error('mailgun.send: at least one recipient is required');
    }

    const form = new URLSearchParams();
    form.append('from', formatAddress(from));
    for (const recipient of recipients) {
      form.append('to', formatAddress(recipient));
    }
    if (message.replyTo) {
      form.append('h:Reply-To', formatAddress(message.replyTo));
    }
    form.append('subject', message.subject);
    form.append('text', message.text);
    if (message.html) {
      form.append('html', message.html);
    }

    // Our MailMessage.tags is a Record<string, string>. Fan out to both:
    //   - o:tag   → analytics tags (string labels)
    //   - v:<k>   → custom variables, returned with webhook events
    if (message.tags) {
      for (const [key, value] of Object.entries(message.tags)) {
        form.append('o:tag', key);
        form.append(`v:${key}`, value);
      }
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
    } catch (err) {
      logger.error(
        { err, to: recipients.map((r) => r.email), subject: message.subject },
        '[mail:mailgun] network error',
      );
      throw err;
    }

    const rawText = await res.text();
    let parsed: MailgunSuccessBody | MailgunErrorBody | null = null;
    try {
      parsed = rawText ? (JSON.parse(rawText) as MailgunSuccessBody | MailgunErrorBody) : null;
    } catch {
      // Non-JSON body — leave parsed=null; log raw on failure.
    }

    if (!res.ok) {
      const reason = (parsed as MailgunErrorBody | null)?.message ?? rawText.slice(0, 400);
      logger.error(
        {
          status: res.status,
          reason,
          to: recipients.map((r) => r.email),
          subject: message.subject,
        },
        '[mail:mailgun] send failed',
      );
      throw new Error(`mailgun.send: HTTP ${res.status} — ${reason}`);
    }

    const success = (parsed as MailgunSuccessBody | null) ?? {};
    // Mailgun returns ids like "<20241231.abc123@mg.example.com>". Strip
    // angle brackets so messageId is consistent across drivers.
    const rawId = success.id ?? null;
    const messageId = rawId ? rawId.replace(/^<|>$/g, '') : null;

    return { messageId, driver: this.name, dispatched: true };
  }
}
