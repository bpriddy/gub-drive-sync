import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));

vi.mock('../../../logger', () => ({ logger: { error: mocks.loggerError } }));

import { MailgunMailDriver } from '../mailgun.driver';
import type { MailMessage } from '../../mail.types';

const API_KEY = 'key-test';
const DEFAULT_FROM = { email: 'noreply@example.com', name: 'Example Co' };
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    to: { email: 'ada@example.com', name: 'Ada Example' },
    subject: 'Hello Acme',
    text: 'Plain body',
    ...overrides,
  };
}

function lastRequest(): { url: string; init: RequestInit; form: URLSearchParams } {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init, form: new URLSearchParams(init.body as string) };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(jsonResponse({ id: '<id-1@mg.example.com>' }));
  vi.stubGlobal('fetch', fetchMock);
  mocks.loggerError.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MailgunMailDriver: request', () => {
  it('posts to the US host by default', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage());
    const { url, init } = lastRequest();
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
    expect(init.method).toBe('POST');
  });

  it('posts to the US host for region "us"', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM, 'us');
    await driver.send(makeMessage());
    expect(lastRequest().url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
  });

  it('posts to the EU host for region "eu"', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM, 'eu');
    await driver.send(makeMessage());
    expect(lastRequest().url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
  });

  it('url-encodes the domain segment', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg example/x.com', DEFAULT_FROM);
    await driver.send(makeMessage());
    expect(lastRequest().url).toBe('https://api.mailgun.net/v3/mg%20example%2Fx.com/messages');
  });

  it('authenticates with basic auth derived from "api:<key>" and sends a form body', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage());
    const { init } = lastRequest();
    expect(init.headers).toEqual({
      Authorization: `Basic ${Buffer.from(`api:${API_KEY}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    const auth = (init.headers as Record<string, string>)['Authorization']!;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe(`api:${API_KEY}`);
    expect(typeof init.body).toBe('string');
  });
});

describe('MailgunMailDriver: form fields', () => {
  it('sends from (default, with display name), to, subject and text; no optional fields', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage());
    const { form } = lastRequest();
    expect([...form.entries()]).toEqual([
      ['from', 'Example Co <noreply@example.com>'],
      ['to', 'Ada Example <ada@example.com>'],
      ['subject', 'Hello Acme'],
      ['text', 'Plain body'],
    ]);
  });

  it('formats an address without a name as the bare email', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', { email: 'bare@example.com' });
    await driver.send(makeMessage({ to: { email: 'to@example.com' } }));
    const { form } = lastRequest();
    expect(form.get('from')).toBe('bare@example.com');
    expect(form.get('to')).toBe('to@example.com');
  });

  it('prefers message.from over the default from', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage({ from: { email: 'ops@example.com', name: 'Ops' } }));
    expect(lastRequest().form.get('from')).toBe('Ops <ops@example.com>');
  });

  it('sends repeated "to" fields for multiple recipients', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(
      makeMessage({
        to: [{ email: 'a@example.com', name: 'Doe, Jane' }, { email: 'b@example.com' }],
      }),
    );
    expect(lastRequest().form.getAll('to')).toEqual(['Doe, Jane <a@example.com>', 'b@example.com']);
  });

  it('sends html and the reply-to header when provided', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(
      makeMessage({
        html: '<p>Hi</p>',
        replyTo: { email: 'help@example.com', name: 'Help Desk' },
      }),
    );
    const { form } = lastRequest();
    expect(form.get('html')).toBe('<p>Hi</p>');
    expect(form.get('h:Reply-To')).toBe('Help Desk <help@example.com>');
  });

  it('fans each tag out to o:tag and a v:<key> custom variable', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(
      makeMessage({ tags: { 'drive.review_notification': 'staff-1', batch: 'b-7' } }),
    );
    const { form } = lastRequest();
    expect(form.getAll('o:tag')).toEqual(['drive.review_notification', 'batch']);
    expect(form.get('v:drive.review_notification')).toBe('staff-1');
    expect(form.get('v:batch')).toBe('b-7');
  });

  it('round-trips special characters in the body through form encoding', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage({ subject: 'Q&A = 100% done', text: 'a+b\nc d' }));
    const { form } = lastRequest();
    expect(form.get('subject')).toBe('Q&A = 100% done');
    expect(form.get('text')).toBe('a+b\nc d');
  });
});

describe('MailgunMailDriver: validation', () => {
  it('rejects when no from address is available, without calling fetch', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', { email: '' });
    await expect(driver.send(makeMessage())).rejects.toThrow(
      'mailgun.send: no `from` address available — set MAIL_FROM_ADDRESS or pass message.from',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an empty recipient list, without calling fetch', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage({ to: [] }))).rejects.toThrow(
      'mailgun.send: at least one recipient is required',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('MailgunMailDriver: result', () => {
  it('returns dispatched with the message id stripped of angle brackets', async () => {
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage())).resolves.toEqual({
      messageId: 'id-1@mg.example.com',
      driver: 'mailgun',
      dispatched: true,
    });
  });

  it('returns a null message id when Mailgun omits it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Queued. Thank you.' }));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage())).resolves.toEqual({
      messageId: null,
      driver: 'mailgun',
      dispatched: true,
    });
  });

  it('treats an empty 200 body as a success with a null id', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage())).resolves.toMatchObject({
      messageId: null,
      dispatched: true,
    });
  });

  it('treats a non-JSON 200 body as a success with a null id', async () => {
    fetchMock.mockResolvedValue(new Response('OK', { status: 200 }));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage())).resolves.toMatchObject({
      messageId: null,
      dispatched: true,
    });
  });
});

describe('MailgunMailDriver: failures', () => {
  it('throws with the status and Mailgun reason on a non-2xx JSON response, and logs it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Forbidden' }, 401));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage({ to: { email: 'ada@example.com' } }))).rejects.toThrow(
      'mailgun.send: HTTP 401 — Forbidden',
    );
    expect(mocks.loggerError).toHaveBeenCalledWith(
      {
        status: 401,
        reason: 'Forbidden',
        to: ['ada@example.com'],
        subject: 'Hello Acme',
      },
      '[mail:mailgun] send failed',
    );
  });

  it('uses the first 400 characters of a non-JSON error body as the reason', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(500), { status: 502 }));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    const err = await driver.send(makeMessage()).catch((e: Error) => e);
    expect((err as Error).message).toBe(`mailgun.send: HTTP 502 — ${'x'.repeat(400)}`);
  });

  it('falls back to the raw body when a JSON error has no message field', async () => {
    fetchMock.mockResolvedValue(new Response('{"code":7}', { status: 400 }));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(driver.send(makeMessage())).rejects.toThrow('mailgun.send: HTTP 400 — {"code":7}');
  });

  it('logs and rethrows the original error when fetch rejects', async () => {
    const networkError = new Error('socket hang up');
    fetchMock.mockRejectedValue(networkError);
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await expect(
      driver.send(makeMessage({ to: [{ email: 'a@example.com' }, { email: 'b@example.com' }] })),
    ).rejects.toBe(networkError);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: networkError, to: ['a@example.com', 'b@example.com'], subject: 'Hello Acme' },
      '[mail:mailgun] network error',
    );
  });

  it('never writes the API key into the error log', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'nope' }, 500));
    const driver = new MailgunMailDriver(API_KEY, 'mg.example.com', DEFAULT_FROM);
    await driver.send(makeMessage()).catch(() => undefined);
    const logged = JSON.stringify(mocks.loggerError.mock.calls);
    expect(logged).not.toContain(API_KEY);
    // Nor the Basic credential derived from it.
    expect(logged).not.toContain(Buffer.from(`api:${API_KEY}`).toString('base64'));
  });
});
