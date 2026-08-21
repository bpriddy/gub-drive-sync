/**
 * embed.ts — Gemini-backed text embedding with mock fallback (D3 #39).
 *
 * Mirrors the gemini.client.ts driver pattern:
 *   - GEMINI_USE_ENTERPRISE+GCP_PROJECT_ID → enterprise surface via ADC
 *   - GEMINI_API_KEY                        → consumer Developer API
 *   - neither                               → deterministic mock embedder so
 *                                             dev/dryrun keeps running keyless.
 *
 * Embedding stack per ruling B4 (recorded in gub-schemas
 * prisma/schema.prisma:580-586): gemini-embedding-001 at 1536 dims via MRL
 * truncation. Non-native dims (≠3072) come back UN-normalized, so every
 * vector is L2-normalized here before it's compared or stored — skipping
 * that skews pgvector `<=>` cosine distances.
 *
 * taskType is SEMANTIC_SIMILARITY (symmetric dedup): candidates and stored
 * insights are the same kind of text, not a query/document pair.
 */

import { GoogleGenAI } from '@google/genai';
import { config } from '../config';
import { logger } from '../logger';
import { isRetryable } from './gemini.client';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIM = 1536;

/**
 * The Developer API caps embedContent batches at 100 texts per request;
 * chunking below the cap keeps one request comfortably sized either way.
 */
const EMBED_BATCH_SIZE = 100;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000; // 1s → 3s → 9s, same posture as completions

export interface EmbeddingDriver {
  readonly name: string;
  /** Embed a list of texts; result[i] corresponds to texts[i]. */
  embedTexts(texts: string[]): Promise<number[][]>;
}

function l2Normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  // Degenerate (all-zero) vectors can't be normalized — pass through
  // rather than divide by zero; cosine against them is meaningless anyway.
  if (!Number.isFinite(norm) || norm === 0) return vec;
  return vec.map((x) => x / norm);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GeminiEmbeddingDriver implements EmbeddingDriver {
  readonly name: string;
  private client: GoogleGenAI;

  constructor(init: { project: string; location: string } | { apiKey: string }) {
    // Same construction as GeminiLlmDriver: our loop owns retries, so the
    // SDK's built-in retry is pinned off to keep backoff deterministic.
    const httpOptions = { retryOptions: { attempts: 1 } };
    if ('project' in init) {
      this.name = 'gemini-enterprise';
      this.client = new GoogleGenAI({
        enterprise: true,
        project: init.project,
        location: init.location,
        httpOptions,
      });
    } else {
      this.name = 'gemini';
      this.client = new GoogleGenAI({ apiKey: init.apiKey, httpOptions });
    }
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const chunk = texts.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await this.embedChunk(chunk);
      out.push(...embeddings);
    }
    return out;
  }

  private async embedChunk(chunk: string[]): Promise<number[][]> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.client.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: chunk,
          config: {
            outputDimensionality: EMBEDDING_DIM,
            taskType: 'SEMANTIC_SIMILARITY',
          },
        });
        const embeddings = res.embeddings ?? [];
        if (embeddings.length !== chunk.length) {
          throw new Error(
            `[embed] expected ${chunk.length} embeddings, got ${embeddings.length}`,
          );
        }
        return embeddings.map((e, idx) => {
          const values = e.values;
          if (!values || values.length !== EMBEDDING_DIM) {
            throw new Error(
              `[embed] embedding ${idx} has ${values?.length ?? 0} dims, expected ${EMBEDDING_DIM}`,
            );
          }
          return l2Normalize(values);
        });
      } catch (err) {
        lastErr = err;
        // Our own shape errors above never match isRetryable's patterns —
        // only transport and API-level transient failures retry.
        const retryable = isRetryable(err);
        const willRetry = retryable && attempt < MAX_ATTEMPTS;
        logger.debug(
          { err, model: EMBEDDING_MODEL, batch: chunk.length, attempt, retryable, willRetry },
          '[embed] embedContent failed',
        );
        if (!willRetry) break;
        await sleep(BASE_BACKOFF_MS * Math.pow(3, attempt - 1));
      }
    }
    throw lastErr;
  }
}

/**
 * Keyless fallback: a deterministic pseudo-embedding derived from an FNV-1a
 * hash of the text, so dev/dryrun and hermetic-ish local runs behave
 * consistently (same text → same vector) without a Gemini credential.
 * Same philosophy as MockLlmDriver — keep the pipeline running, loudly.
 */
class MockEmbeddingDriver implements EmbeddingDriver {
  readonly name = 'mock';

  async embedTexts(texts: string[]): Promise<number[][]> {
    logger.info({ count: texts.length }, '[embed:mock] returning deterministic pseudo-vectors');
    return texts.map((t) => l2Normalize(pseudoVector(t)));
  }
}

function pseudoVector(text: string): number[] {
  // FNV-1a seed, then a mulberry32 stream — cheap, stable across runs.
  let seed = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vec = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] = next() * 2 - 1;
  return vec;
}

function createEmbeddingDriver(): EmbeddingDriver {
  if (config.GEMINI_USE_ENTERPRISE && config.GCP_PROJECT_ID) {
    return new GeminiEmbeddingDriver({
      project: config.GCP_PROJECT_ID,
      location: config.GEMINI_LOCATION,
    });
  }
  if (config.GEMINI_API_KEY) {
    return new GeminiEmbeddingDriver({ apiKey: config.GEMINI_API_KEY });
  }
  logger.warn(
    '[embed] no Gemini config (GEMINI_USE_ENTERPRISE+GCP_PROJECT_ID or GEMINI_API_KEY) — using mock embedder. Vectors are deterministic pseudo-embeddings.',
  );
  return new MockEmbeddingDriver();
}

export const defaultEmbedder: EmbeddingDriver = createEmbeddingDriver();

/** Convenience wrapper over the module-level driver. */
export function embedTexts(texts: string[]): Promise<number[][]> {
  return defaultEmbedder.embedTexts(texts);
}
