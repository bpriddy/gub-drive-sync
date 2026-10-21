/**
 * Env validation for the download budget settings (DOWNLOAD_INFLIGHT_BYTES /
 * DOWNLOAD_HEAVY_BYTES). `config.ts` runs loadConfig() at import, so the one
 * required variable is set before the module loads; each test then calls
 * loadConfig() itself against a controlled environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env['DATABASE_URL'] = 'postgresql://user:pass@localhost:5432/test';
});

import { loadConfig } from '../config';

const MIB = 1024 * 1024;
const KEYS = ['DOWNLOAD_INFLIGHT_BYTES', 'DOWNLOAD_HEAVY_BYTES'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('download budget settings', () => {
  it('default to a 600 MiB in-flight budget and a 50 MiB heavy threshold', () => {
    const c = loadConfig();
    expect(c.DOWNLOAD_INFLIGHT_BYTES).toBe(600 * MIB);
    expect(c.DOWNLOAD_HEAVY_BYTES).toBe(50 * MIB);
  });

  it('parse overrides as integers, and treat an empty string as unset', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1000';
    const c = loadConfig();
    expect(c.DOWNLOAD_INFLIGHT_BYTES).toBe(600 * MIB);
    expect(c.DOWNLOAD_HEAVY_BYTES).toBe(1000);
  });

  it('accept a heavy threshold equal to the budget', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '1000';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1000';
    expect(() => loadConfig()).not.toThrow();
  });

  it('fail boot when the heavy threshold exceeds the budget', () => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = '1000';
    process.env['DOWNLOAD_HEAVY_BYTES'] = '1001';
    expect(() => loadConfig()).toThrow(
      /DOWNLOAD_HEAVY_BYTES: must not exceed DOWNLOAD_INFLIGHT_BYTES \(1001 > 1000\)/,
    );
  });

  it('fail boot when a heavy threshold above the default budget is set alone', () => {
    process.env['DOWNLOAD_HEAVY_BYTES'] = String(700 * MIB);
    expect(() => loadConfig()).toThrow(/DOWNLOAD_HEAVY_BYTES: must not exceed/);
  });

  // 1e300 parses as an "integer" but no byte count is that large: refused at
  // boot, not at the first download when the budget is built.
  it.each(['0', '-5', '1.5', 'abc', '1e', '1e300'])('reject %j as a size', (bad) => {
    process.env['DOWNLOAD_INFLIGHT_BYTES'] = bad;
    expect(() => loadConfig()).toThrow(/DOWNLOAD_INFLIGHT_BYTES/);
    delete process.env['DOWNLOAD_INFLIGHT_BYTES'];
    process.env['DOWNLOAD_HEAVY_BYTES'] = bad;
    expect(() => loadConfig()).toThrow(/DOWNLOAD_HEAVY_BYTES/);
  });
});
