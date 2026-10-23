/**
 * console.driver.test.ts — the dry-run mail driver: never dispatches, and
 * logs the envelope and the body length, never the body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../logger', () => ({ logger: h.logger }));

import { ConsoleMailDriver } from '../console.driver';

const BODY_MARKER = 'body-only-marker-7f3a';

beforeEach(() => {
  h.logger.info.mockReset();
});

describe('ConsoleMailDriver', () => {
  it('never dispatches and reports itself as a dry run', async () => {
    const result = await new ConsoleMailDriver().send({
      to: { email: 'owner@example.com' },
      subject: 'Review requested',
      text: 'Please review.',
    });

    expect(result).toEqual({ messageId: null, driver: 'console', dispatched: false });
  });

  it('logs recipients, subject, tags and the body length, never the body', async () => {
    const text = `Open https://review.example/item/${BODY_MARKER} to continue.`;

    await new ConsoleMailDriver().send({
      to: [{ email: 'a@example.com' }, { email: 'b@example.com', name: 'B' }],
      subject: 'Review requested',
      text,
      html: `<a href="https://review.example/item/${BODY_MARKER}">Open</a>`,
      tags: { kind: 'review' },
    });

    expect(h.logger.info).toHaveBeenCalledTimes(1);
    const [fields, message] = h.logger.info.mock.calls[0]! as [
      { mail: Record<string, unknown> },
      string,
    ];
    expect(fields.mail).toEqual({
      to: ['a@example.com', 'b@example.com'],
      subject: 'Review requested',
      tags: { kind: 'review' },
      textLength: text.length,
      hasHtml: true,
    });
    expect(message).toBe('[mail:console] (dry-run) not dispatched');
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain(BODY_MARKER);
  });
});
