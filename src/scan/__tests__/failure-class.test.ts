import { describe, expect, it } from 'vitest';
import { ApiError } from '@google/genai';
import { isTransientFailure } from '../failure-class';

describe('isTransientFailure', () => {
  it('accepts what a re-run of the window can recover', () => {
    expect(isTransientFailure(new ApiError({ message: 'x', status: 429 }))).toBe(true);
    expect(isTransientFailure(new ApiError({ message: 'x', status: 503 }))).toBe(true);
    expect(isTransientFailure(new Error('Retryable HTTP Error: Service Unavailable'))).toBe(true);
    expect(isTransientFailure({ code: 500 })).toBe(true); // Drive 5xx
    expect(isTransientFailure({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientFailure({ code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })).toBe(
      true,
    );
    expect(isTransientFailure({ code: 'P1001', message: "Can't reach database server" })).toBe(
      true,
    );
    expect(isTransientFailure({ code: 'P2024', message: 'Timed out fetching a connection' })).toBe(
      true,
    );
  });

  it('rejects what every re-run would repeat', () => {
    expect(isTransientFailure(new ApiError({ message: 'x', status: 400 }))).toBe(false);
    expect(isTransientFailure({ code: 403, errors: [{ reason: 'forbidden' }] })).toBe(false);
    expect(isTransientFailure({ code: 404 })).toBe(false);
    expect(isTransientFailure(new Error('Invalid PDF structure'))).toBe(false);
    expect(isTransientFailure(new SyntaxError('Unexpected end of JSON input'))).toBe(false);
    expect(isTransientFailure({ code: 'P2002', message: 'Unique constraint failed' })).toBe(false);
    expect(isTransientFailure(null)).toBe(false);
  });
});
