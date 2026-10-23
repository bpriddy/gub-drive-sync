import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  fetch: vi.fn(),
  config: {} as Record<string, unknown>,
}));

vi.mock('../../config', () => ({ config: mocks.config }));
vi.mock('../../logger', () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: mocks.loggerError },
}));

const MESSAGE = {
  to: { email: 'ada@example.com', name: 'Ada Example' },
  subject: 'Hello Acme',
  text: 'Plain body',
};

function setConfig(values: Record<string, unknown>): void {
  for (const key of Object.keys(mocks.config)) delete mocks.config[key];
  Object.assign(mocks.config, {
    MAIL_DRIVER: 'console',
    MAILGUN_REGION: 'us',
    MAIL_FROM_NAME: 'Example Co',
    ...values,
  });
}

async function loadMail() {
  vi.resetModules();
  return (await import('../mail.service')).mail;
}

const FULL_MAILGUN = {
  MAIL_DRIVER: 'mailgun',
  MAILGUN_API_KEY: 'key-test',
  MAILGUN_DOMAIN: 'mg.example.com',
  MAIL_FROM_ADDRESS: 'noreply@example.com',
};

beforeEach(() => {
  mocks.loggerInfo.mockReset();
  mocks.loggerWarn.mockReset();
  mocks.loggerError.mockReset();
  mocks.fetch
    .mockReset()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: '<id-1@mg.example.com>' }), { status: 200 }),
    );
  vi.stubGlobal('fetch', mocks.fetch);
  setConfig({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mail service: driver selection', () => {
  it('uses the console driver when MAIL_DRIVER=console', async () => {
    const mail = await loadMail();
    expect(mail.driverName).toBe('console');
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('uses the mailgun driver when fully configured', async () => {
    setConfig(FULL_MAILGUN);
    const mail = await loadMail();
    expect(mail.driverName).toBe('mailgun');
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('logs the chosen driver and default from address on init', async () => {
    setConfig(FULL_MAILGUN);
    await loadMail();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { driver: 'mailgun', from: 'noreply@example.com' },
      '[mail] initialized',
    );
  });

  it.each([
    [
      'API key',
      { MAILGUN_API_KEY: undefined },
      { hasApiKey: false, hasDomain: true, hasFrom: true },
    ],
    ['domain', { MAILGUN_DOMAIN: undefined }, { hasApiKey: true, hasDomain: false, hasFrom: true }],
    [
      'from address',
      { MAIL_FROM_ADDRESS: undefined },
      { hasApiKey: true, hasDomain: true, hasFrom: false },
    ],
    [
      'empty API key',
      { MAILGUN_API_KEY: '' },
      { hasApiKey: false, hasDomain: true, hasFrom: true },
    ],
  ])(
    'falls back to console with a warning when mailgun lacks the %s',
    async (_label, patch, flags) => {
      setConfig({ ...FULL_MAILGUN, ...patch });
      const mail = await loadMail();
      expect(mail.driverName).toBe('console');
      expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
      expect(mocks.loggerWarn).toHaveBeenCalledWith(
        flags,
        '[mail] MAIL_DRIVER=mailgun but MAILGUN_API_KEY, MAILGUN_DOMAIN, or MAIL_FROM_ADDRESS missing — falling back to console driver',
      );
    },
  );

  it('never warns or selects mailgun for the console driver even when mailgun settings exist', async () => {
    setConfig({ ...FULL_MAILGUN, MAIL_DRIVER: 'console' });
    const mail = await loadMail();
    expect(mail.driverName).toBe('console');
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});

describe('mail service: send with the console driver', () => {
  it('does not dispatch and logs the recipients and subject', async () => {
    const mail = await loadMail();
    const result = await mail.send({
      ...MESSAGE,
      to: [{ email: 'ada@example.com' }, { email: 'bob@example.com' }],
    });
    expect(result).toMatchObject({ dispatched: false, driver: 'console' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      {
        mail: expect.objectContaining({
          to: ['ada@example.com', 'bob@example.com'],
          subject: 'Hello Acme',
        }),
      },
      expect.stringContaining('[mail:console]'),
    );
  });

  it('handles a single (non-array) recipient', async () => {
    const mail = await loadMail();
    await mail.send(MESSAGE);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { mail: expect.objectContaining({ to: ['ada@example.com'], subject: 'Hello Acme' }) },
      expect.stringContaining('[mail:console]'),
    );
  });
});

describe('mail service: send with the mailgun driver', () => {
  it('fills in the default from address (with name) when the message has none', async () => {
    setConfig(FULL_MAILGUN);
    const mail = await loadMail();
    const result = await mail.send(MESSAGE);

    expect(result).toEqual({
      messageId: 'id-1@mg.example.com',
      driver: 'mailgun',
      dispatched: true,
    });
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
    expect(new URLSearchParams(init.body as string).get('from')).toBe(
      'Example Co <noreply@example.com>',
    );
  });

  it('keeps an explicit message.from', async () => {
    setConfig(FULL_MAILGUN);
    const mail = await loadMail();
    await mail.send({ ...MESSAGE, from: { email: 'ops@example.com', name: 'Ops' } });
    const init = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect(new URLSearchParams(init.body as string).get('from')).toBe('Ops <ops@example.com>');
  });

  it('passes the configured EU region through to the driver', async () => {
    setConfig({ ...FULL_MAILGUN, MAILGUN_REGION: 'eu' });
    const mail = await loadMail();
    await mail.send(MESSAGE);
    expect(mocks.fetch.mock.calls[0]![0]).toBe(
      'https://api.eu.mailgun.net/v3/mg.example.com/messages',
    );
  });

  it('propagates a driver failure to the caller', async () => {
    setConfig(FULL_MAILGUN);
    mocks.fetch.mockResolvedValue(new Response('{"message":"Forbidden"}', { status: 401 }));
    const mail = await loadMail();
    await expect(mail.send(MESSAGE)).rejects.toThrow('mailgun.send: HTTP 401 — Forbidden');
  });
});
