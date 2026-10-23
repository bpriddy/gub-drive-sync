/**
 * eval-ideas-lib.ts — the parts of scripts/eval-ideas.ts that make no model
 * call: the fixture format, prices and the spend guard, the fuzzy match and
 * the metrics. The unit suite covers all of it.
 *
 * Matching (documented in the README, "Ideas eval"): an extracted idea and a
 * gold idea of the same deck are compared with pg_trgm's whole-string
 * similarity(). (GUB's discovery search ranks by word_similarity(), a
 * different scale.) The pair's score is the better of
 *   - the names (the gold name or any of its aliases), and
 *   - the facet rows, each side joined into one text.
 * A pair counts as a hit at score >= the threshold (DEFAULT_THRESHOLD,
 * overridable per run). Hits are assigned one-to-one, best score first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LlmCompletionRequest, LlmCompletionResult, LlmDriver } from '../src/ai';
import type { matchAndMergeIdea } from '../src/drive/idea-matcher';

// ── Fixtures ────────────────────────────────────────────────────────────────

export const DECK_TYPES = ['pitch', 'creative_review', 'other'] as const;
export type DeckTypeLabel = (typeof DECK_TYPES)[number];

const GoldIdeaSchema = z
  .object({
    /** Identity across decks: the same key in two decks is the same idea. */
    key: z.string().min(1),
    name: z.string().min(1),
    /** Other names the idea goes by (renamed rounds); also match. */
    aliases: z.array(z.string().min(1)).default([]),
    facets: z.array(z.string().min(1)).default([]),
  })
  .strict();

const GoldDeckSchema = z
  .object({
    /** File name shown to the model (default: the deck id). */
    name: z.string().min(1).optional(),
    /** Folder path shown to the model (default: empty). */
    path: z.string().optional(),
    /** Account name; the merge stage runs per account (default: one group). */
    account: z.string().min(1).optional(),
    /** Chronological position within the account; the merge stage runs in this order. */
    order: z.number().optional(),
    deckType: z.enum(DECK_TYPES),
    ideas: z.array(GoldIdeaSchema).default([]),
  })
  .strict();

export type GoldIdea = z.infer<typeof GoldIdeaSchema>;
export type GoldDeck = z.infer<typeof GoldDeckSchema>;

export interface FixtureDeck {
  id: string;
  text: string;
  gold: GoldDeck;
}

const GOLD_SUFFIX = '.gold.json';
const TEXT_SUFFIX = '.txt';
const NO_ACCOUNT = '(no account)';

export function accountOf(deck: FixtureDeck): string {
  return deck.gold.account ?? NO_ACCOUNT;
}

/** Validates one gold file's content; throws with the deck id in the message. */
export function parseGoldDeck(id: string, raw: unknown): GoldDeck {
  const parsed = GoldDeckSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.errors.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`);
    throw new Error(`${id}${GOLD_SUFFIX}: ${why.join('; ')}`);
  }
  const gold = parsed.data;
  if (gold.deckType === 'other' && gold.ideas.length > 0) {
    throw new Error(`${id}${GOLD_SUFFIX}: deckType "other" cannot list ideas`);
  }
  const keys = new Set<string>();
  for (const idea of gold.ideas) {
    if (keys.has(idea.key)) {
      throw new Error(`${id}${GOLD_SUFFIX}: key "${idea.key}" appears twice in one deck`);
    }
    keys.add(idea.key);
  }
  return gold;
}

/**
 * Every `<id>.gold.json` with its `<id>.txt`, in merge order: by account,
 * then `order`, then id. A text without a gold file (or the reverse) is an
 * error, so a half-annotated set never scores silently.
 */
export function loadFixtures(dir: string): FixtureDeck[] {
  const names = fs.readdirSync(dir);
  const goldIds = names
    .filter((n) => n.endsWith(GOLD_SUFFIX))
    .map((n) => n.slice(0, -GOLD_SUFFIX.length));
  const textIds = new Set(
    names.filter((n) => n.endsWith(TEXT_SUFFIX)).map((n) => n.slice(0, -TEXT_SUFFIX.length)),
  );
  const problems: string[] = [];
  for (const id of goldIds)
    if (!textIds.has(id)) problems.push(`${id}${GOLD_SUFFIX} has no ${id}${TEXT_SUFFIX}`);
  for (const id of textIds)
    if (!goldIds.includes(id)) problems.push(`${id}${TEXT_SUFFIX} has no ${id}${GOLD_SUFFIX}`);
  if (problems.length > 0) throw new Error(`fixtures in ${dir}: ${problems.join('; ')}`);
  if (goldIds.length === 0) throw new Error(`fixtures in ${dir}: no *${GOLD_SUFFIX} files`);

  const decks = goldIds.map((id) => ({
    id,
    text: fs.readFileSync(path.join(dir, `${id}${TEXT_SUFFIX}`), 'utf8'),
    gold: parseGoldDeck(
      id,
      JSON.parse(fs.readFileSync(path.join(dir, `${id}${GOLD_SUFFIX}`), 'utf8')),
    ),
  }));
  return decks.sort(
    (a, b) =>
      accountOf(a).localeCompare(accountOf(b)) ||
      (a.gold.order ?? Number.MAX_SAFE_INTEGER) - (b.gold.order ?? Number.MAX_SAFE_INTEGER) ||
      a.id.localeCompare(b.id),
  );
}

// ── Prices and the spend guard ─────────────────────────────────────────────

/**
 * gemini-3.5-flash on the global endpoint, USD per 1M tokens (Cloud Billing
 * SKUs). Thoughts bill as output.
 */
export const PRICE_PER_M_TOKENS = { input: 1.5, output: 9.0 } as const;

export interface Tokens {
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export function costUsd(t: Tokens): number {
  return (
    (t.promptTokens * PRICE_PER_M_TOKENS.input +
      (t.outputTokens + t.thoughtsTokens) * PRICE_PER_M_TOKENS.output) /
    1_000_000
  );
}

/**
 * Prompt tokens, over-estimated on purpose: one token per 3 UTF-8 bytes.
 * Real usage runs nearer 4 characters per token for English, so the guard
 * errs on the safe side; a non-Latin deck costs more bytes per character.
 */
export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3);
}

/** The most one call can cost: its prompt plus its whole output allowance. */
export function worstCaseUsd(prompt: string, maxOutputTokens: number): number {
  return costUsd({
    promptTokens: estimatePromptTokens(prompt),
    outputTokens: maxOutputTokens,
    thoughtsTokens: 0,
  });
}

/** Spend guard: a call starts only if its worst case still fits under the cap. */
export class Budget {
  spentUsd = 0;
  constructor(readonly maxUsd: number) {}
  allows(worstUsd: number): boolean {
    return this.spentUsd + worstUsd <= this.maxUsd;
  }
  add(usd: number): void {
    this.spentUsd += usd;
  }
}

export class BudgetStop extends Error {
  constructor(
    readonly spentUsd: number,
    readonly nextWorstUsd: number,
    readonly maxUsd: number,
  ) {
    super(
      `budget: $${spentUsd.toFixed(4)} spent, the next call may cost up to $${nextWorstUsd.toFixed(4)}; stopping under --max-usd ${maxUsd}`,
    );
  }
}

/**
/** Attempts the Gemini driver makes per call (src/ai/gemini.client.ts MAX_ATTEMPTS). */
export const DRIVER_ATTEMPTS = 3;

/**
 * What a finished call costs. The output side is the larger of output +
 * thoughts and total - prompt, so a missing thoughts count is still paid
 * for; without a prompt count, or without any output-side count, the call
 * is charged its worst case.
 */
export function chargeFor(usage: LlmCompletionResult['usage'], worstUsd: number): number {
  if (!usage || usage.promptTokens === null) return worstUsd;
  const parts = (usage.outputTokens ?? 0) + (usage.thoughtsTokens ?? 0);
  const fromTotal = usage.totalTokens !== null ? usage.totalTokens - usage.promptTokens : null;
  if (usage.outputTokens === null && fromTotal === null) return worstUsd;
  return costUsd({
    promptTokens: usage.promptTokens,
    outputTokens: Math.max(parts, fromTotal ?? 0),
    thoughtsTokens: 0,
  });
}

/**
 * Wraps the shared driver: every call is checked against the budget before
 * it starts and charged after it ends: chargeFor() on success, the worst
 * case of every driver attempt on failure. A call the driver retried and
 * then completed is charged for its last attempt only; the earlier attempts
 * are not visible here. `free` (the mock driver) charges nothing.
 */
export function guardDriver(
  llm: LlmDriver,
  budget: Budget,
  calls: CallRecord[],
  free: boolean,
): void {
  const complete = llm.complete.bind(llm);
  llm.complete = async (req: LlmCompletionRequest): Promise<LlmCompletionResult> => {
    const worst = free ? 0 : worstCaseUsd(req.prompt, req.maxOutputTokens ?? 65_536);
    if (!budget.allows(worst)) throw new BudgetStop(budget.spentUsd, worst, budget.maxUsd);
    const started = Date.now();
    try {
      const res = await complete(req);
      const u = res.usage;
      const usd = free ? 0 : chargeFor(u, worst);
      budget.add(usd);
      calls.push({
        tag: req.tag ?? null,
        ok: true,
        promptTokens: u?.promptTokens ?? null,
        outputTokens: u?.outputTokens ?? null,
        thoughtsTokens: u?.thoughtsTokens ?? null,
        usd,
        latencyMs: Date.now() - started,
      });
      return res;
    } catch (err) {
      // The driver may have tried several times before giving up.
      const usd = worst * DRIVER_ATTEMPTS;
      budget.add(usd);
      calls.push({
        tag: req.tag ?? null,
        ok: false,
        promptTokens: null,
        outputTokens: null,
        thoughtsTokens: null,
        usd,
        latencyMs: Date.now() - started,
      });
      throw err;
    }
  };
}

/**
 * The path with symlinks resolved: the deepest ancestor that exists goes
 * through realpath and the missing tail is re-appended, so a directory the
 * run is about to create under a symlink still resolves to where it lands.
 */
function resolveReal(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  while (!fs.existsSync(head)) {
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

/** True when `child` is `parent` or lies below it, symlinks resolved. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(resolveReal(parent), resolveReal(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ── Fuzzy match ─────────────────────────────────────────────────────────────

/** The default hit threshold. See the README for how it was chosen and how to tune it. */
export const DEFAULT_THRESHOLD = 0.4;

/** Facet pairs at or above this similarity inside one idea are near-duplicates. */
export const NEAR_DUPLICATE_FACET = 0.8;

/** Lowercase, accents stripped, anything but letters and digits turned into spaces. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** pg_trgm's trigram set: each word padded with two blanks in front and one behind. */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of normalize(s).split(' ')) {
    if (!word) continue;
    const padded = `  ${word} `;
    const chars = Array.from(padded);
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

/** pg_trgm `similarity()`: shared trigrams over all distinct trigrams, 0..1. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

export interface IdeaLike {
  name: string;
  facets: string[];
}

export interface PairScore {
  name: number;
  facets: number;
  score: number;
}

export function scorePair(extracted: IdeaLike, gold: GoldIdea): PairScore {
  const name = Math.max(
    ...[gold.name, ...gold.aliases].map((n) => trigramSimilarity(extracted.name, n)),
  );
  const facets =
    extracted.facets.length > 0 && gold.facets.length > 0
      ? trigramSimilarity(extracted.facets.join(' '), gold.facets.join(' '))
      : 0;
  return { name, facets, score: Math.max(name, facets) };
}

export interface Assignment {
  /** extracted index → gold index, for hits only. */
  hits: Map<number, number>;
  /** Unmatched extracted ideas that score >= threshold against an already-matched gold idea. */
  duplicates: number[];
  scores: PairScore[][];
}

/** One-to-one assignment, best score first; ties keep list order. */
export function assign(extracted: IdeaLike[], gold: GoldIdea[], threshold: number): Assignment {
  const scores = extracted.map((e) => gold.map((g) => scorePair(e, g)));
  const pairs: Array<{ e: number; g: number; score: number }> = [];
  scores.forEach((row, e) =>
    row.forEach((s, g) => {
      if (s.score >= threshold) pairs.push({ e, g, score: s.score });
    }),
  );
  pairs.sort((a, b) => b.score - a.score || a.e - b.e || a.g - b.g);
  const hits = new Map<number, number>();
  const takenGold = new Set<number>();
  for (const p of pairs) {
    if (hits.has(p.e) || takenGold.has(p.g)) continue;
    hits.set(p.e, p.g);
    takenGold.add(p.g);
  }
  const duplicates = extracted
    .map((_, e) => e)
    .filter(
      (e) => !hits.has(e) && scores[e]!.some((s, g) => takenGold.has(g) && s.score >= threshold),
    );
  return { hits, duplicates, scores };
}

// ── The saved run ───────────────────────────────────────────────────────────

export interface CallRecord {
  tag: string | null;
  ok: boolean;
  promptTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
  /** Reported usage priced; the worst case when the call failed or reported none. */
  usd: number;
  latencyMs: number;
}

export interface DeckRun {
  id: string;
  /** null when the extraction failed. */
  deckType: DeckTypeLabel | null;
  ideas: IdeaLike[];
  error: string | null;
}

export type MergeAction = 'create' | 'update' | 'noop' | 'create_after_match_error';

export interface MergeDecision {
  account: string;
  deckId: string;
  /** Index into that deck's extracted ideas. */
  ideaIndex: number;
  /** The memory row this idea created or merged into (run-local id). */
  clusterId: string;
  action: MergeAction;
}

export interface ClusterState {
  id: string;
  account: string;
  name: string;
  facets: string[];
}

export interface RunFile {
  version: 1;
  kind: 'eval-ideas-run';
  startedAt: string;
  finishedAt: string | null;
  driver: string;
  model: string;
  maxUsd: number;
  spentUsd: number;
  stoppedByBudget: string | null;
  calls: CallRecord[];
  decks: DeckRun[];
  merge: { ran: boolean; decisions: MergeDecision[]; clusters: ClusterState[] };
}

/** What the merge stage needs from the pipeline: the production matcher and its no-op test. */
export interface MergeDeps {
  matchAndMergeIdea: typeof matchAndMergeIdea;
  facetsEqual: (a: string[], b: string[]) => boolean;
}

/**
 * The scan's mergeIdeaCandidates loop, in memory: one known-ideas list per
 * account, deck order, a matcher failure creates the idea as new, a merge
 * that changes nothing is a no-op. Appends to run.merge, calling
 * `onDecision` after each decision (the caller checkpoints the run file
 * there); stops at BudgetStop.
 */
export async function runMergeStage(
  p: MergeDeps,
  decks: FixtureDeck[],
  run: RunFile,
  onDecision: () => void = () => {},
): Promise<void> {
  const record = (d: MergeDecision) => {
    run.merge.decisions.push(d);
    onDecision();
  };
  const known = new Map<string, ClusterState[]>();
  let next = 1;
  const decksById = new Map(decks.map((d) => [d.id, d]));
  for (const deckRun of run.decks) {
    const deck = decksById.get(deckRun.id)!;
    const account = accountOf(deck);
    const rows = known.get(account) ?? [];
    known.set(account, rows);
    for (const [ideaIndex, idea] of deckRun.ideas.entries()) {
      let matchId: string | null;
      let mergedFacets: string[];
      let matchFailed = false;
      try {
        ({ matchId, mergedFacets } = await p.matchAndMergeIdea({
          newIdea: idea,
          existingIdeas: rows,
          accountName: deck.gold.account ?? null,
        }));
      } catch (err) {
        if (err instanceof BudgetStop) {
          run.stoppedByBudget = err.message;
          return;
        }
        matchId = null;
        mergedFacets = idea.facets;
        matchFailed = true;
      }
      const decision: Omit<MergeDecision, 'clusterId' | 'action'> = {
        account,
        deckId: deck.id,
        ideaIndex,
      };
      if (matchId) {
        const target = rows.find((r) => r.id === matchId)!;
        if (p.facetsEqual(target.facets, mergedFacets)) {
          record({ ...decision, clusterId: target.id, action: 'noop' });
          continue;
        }
        target.facets = mergedFacets;
        record({ ...decision, clusterId: target.id, action: 'update' });
      } else {
        const row: ClusterState = {
          id: `row-${next++}`,
          account,
          name: idea.name,
          facets: mergedFacets,
        };
        rows.push(row);
        run.merge.clusters.push(row);
        record({
          ...decision,
          clusterId: row.id,
          action: matchFailed ? 'create_after_match_error' : 'create',
        });
      }
    }
  }
}

/** A saved run's outer shape, checked before scoring. */
export function isRunFile(x: unknown): x is RunFile {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Partial<RunFile>;
  return (
    r.kind === 'eval-ideas-run' &&
    r.version === 1 &&
    Array.isArray(r.decks) &&
    Array.isArray(r.calls) &&
    typeof r.spentUsd === 'number' &&
    typeof r.merge === 'object' &&
    r.merge !== null &&
    Array.isArray(r.merge.decisions) &&
    Array.isArray(r.merge.clusters)
  );
}

// ── Arguments ───────────────────────────────────────────────────────────────

export interface Args {
  mode: 'extract' | 'score';
  fixtures: string;
  out: string | null;
  run: string | null;
  maxUsd: number | null;
  limit: number | null;
  merge: boolean;
  plan: boolean;
  allowMock: boolean;
  threshold: number;
}

const VALUE_FLAGS = [
  '--fixtures',
  '--out',
  '--run',
  '--max-usd',
  '--limit',
  '--threshold',
] as const;
const BOOLEAN_FLAGS = ['--no-merge', '--plan', '--allow-mock'] as const;

/**
 * Strict on purpose: a paid run must not start on a typo. Unknown flags, a
 * flag without a value, and a value that looks like a flag all throw. An
 * empty environment variable counts as unset.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const [mode, ...rest] = argv;
  if (mode !== 'extract' && mode !== 'score') {
    throw new Error('first argument must be "extract" or "score"');
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if ((VALUE_FLAGS as readonly string[]).includes(tok)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${tok} needs a value`);
      values.set(tok, v);
      i++;
    } else if ((BOOLEAN_FLAGS as readonly string[]).includes(tok)) {
      flags.add(tok);
    } else {
      throw new Error(`unknown argument ${tok}`);
    }
  }
  const nonEmpty = (v: string | undefined) => (v === undefined || v === '' ? null : v);
  const num = (flag: string): number | null => {
    const raw = values.get(flag);
    if (raw === undefined) return null;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`${flag} must be a number`);
    return n;
  };

  const fixtures = nonEmpty(values.get('--fixtures')) ?? nonEmpty(env['EVAL_IDEAS_FIXTURES']);
  if (fixtures === null) throw new Error('--fixtures <dir> (or EVAL_IDEAS_FIXTURES) is required');
  const maxUsd = num('--max-usd');
  if (maxUsd !== null && !(maxUsd > 0)) throw new Error('--max-usd must be a positive number');
  const limit = num('--limit');
  if (limit !== null && !(Number.isInteger(limit) && limit > 0)) {
    throw new Error('--limit must be a positive integer');
  }
  const threshold = num('--threshold') ?? DEFAULT_THRESHOLD;
  if (!(threshold > 0 && threshold <= 1)) throw new Error('--threshold must be in (0, 1]');

  const args: Args = {
    mode,
    fixtures: path.resolve(fixtures),
    out: nonEmpty(values.get('--out')) ?? nonEmpty(env['EVAL_IDEAS_OUT']),
    run: nonEmpty(values.get('--run')),
    maxUsd,
    limit,
    merge: !flags.has('--no-merge'),
    plan: flags.has('--plan'),
    allowMock: flags.has('--allow-mock'),
    threshold,
  };
  if (mode === 'score' && args.run === null) throw new Error('score needs --run <run file>');
  if (mode === 'extract' && !args.plan) {
    if (args.maxUsd === null) throw new Error('extract needs --max-usd');
    if (args.out === null) throw new Error('extract needs --out <dir> (or EVAL_IDEAS_OUT)');
  }
  return args;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export interface DeckScore {
  id: string;
  goldDeckType: DeckTypeLabel;
  deckType: DeckTypeLabel | null;
  gold: number;
  extracted: number;
  hits: number;
  duplicates: number;
  matched: Array<{ extracted: string; gold: string; key: string; score: number }>;
  missed: string[];
  spurious: Array<{ extracted: string; bestGold: string | null; bestScore: number }>;
  error: string | null;
}

export interface ScoreReport {
  threshold: number;
  decks: number;
  extractionErrors: number;
  extraction: {
    gold: number;
    extracted: number;
    hits: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
    duplicates: number;
    /**
     * Pairs scoring within 0.15 below the threshold, for extracted ideas left
     * without a hit: candidates for an alias or a retune.
     */
    nearMisses: Array<{ deckId: string; extracted: string; gold: string; score: number }>;
  };
  /** Failed extractions are left out of every deck-type figure. */
  deckType: {
    /** Exact label match: pitch and creative_review count as different. */
    accuracy: number | null;
    /** Idea deck vs other only, which is all the gate decides. */
    gateAccuracy: number | null;
    /** `gold->predicted` counts. */
    confusion: Record<string, number>;
    /** Idea decks the gate turned away: all their ideas are lost. */
    missedIdeaDecks: number;
    /** Non-idea decks the gate let through. */
    falseIdeaDecks: number;
  };
  merge: {
    ran: boolean;
    decisions: number;
    /** Merges where both sides map to a gold idea. */
    scoredMerges: number;
    correctMerges: number;
    falseMerges: number;
    falseMergeRate: number | null;
    /** Merges where either side is a spurious idea. */
    unscoredMerges: number;
    /** Creates although the account already held a row for the same gold idea. */
    missedMerges: number;
    /** Extra memory rows per gold idea after the run (rows - 1, summed). */
    duplicateRows: number;
    /** Memory rows that absorbed more than one gold idea. */
    impureRows: number;
    nearDuplicateFacetPairs: number;
    matchErrors: number;
  };
  cost: { calls: number; failedCalls: number; spentUsd: number; stoppedByBudget: string | null };
  perDeck: DeckScore[];
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function score(fixtures: FixtureDeck[], run: RunFile, threshold: number): ScoreReport {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const unknown = run.decks.filter((d) => !byId.has(d.id)).map((d) => d.id);
  if (unknown.length > 0) throw new Error(`run has decks the fixtures lack: ${unknown.join(', ')}`);

  const perDeck: DeckScore[] = [];
  const nearMisses: ScoreReport['extraction']['nearMisses'] = [];
  const confusion: Record<string, number> = {};
  /** `${deckId}#${ideaIndex}` → gold key, for extracted ideas that hit. */
  const keyOf = new Map<string, string>();

  for (const deck of run.decks) {
    const gold = byId.get(deck.id)!.gold;
    const a = assign(deck.ideas, gold.ideas, threshold);
    for (const [e, g] of a.hits) keyOf.set(`${deck.id}#${e}`, gold.ideas[g]!.key);
    a.scores.forEach((row, e) =>
      row.forEach((s, g) => {
        if (s.score < threshold && s.score >= threshold - 0.15 && !a.hits.has(e)) {
          nearMisses.push({
            deckId: deck.id,
            extracted: deck.ideas[e]!.name,
            gold: gold.ideas[g]!.name,
            score: round(s.score),
          });
        }
      }),
    );
    if (deck.deckType !== null) {
      const k = `${gold.deckType}->${deck.deckType}`;
      confusion[k] = (confusion[k] ?? 0) + 1;
    }
    const matchedGold = new Set(a.hits.values());
    perDeck.push({
      id: deck.id,
      goldDeckType: gold.deckType,
      deckType: deck.deckType,
      gold: gold.ideas.length,
      extracted: deck.ideas.length,
      hits: a.hits.size,
      duplicates: a.duplicates.length,
      matched: [...a.hits].map(([e, g]) => ({
        extracted: deck.ideas[e]!.name,
        gold: gold.ideas[g]!.name,
        key: gold.ideas[g]!.key,
        score: round(a.scores[e]![g]!.score),
      })),
      missed: gold.ideas.filter((_, g) => !matchedGold.has(g)).map((g) => g.name),
      spurious: deck.ideas
        .map((idea, e) => ({ idea, e }))
        .filter(({ e }) => !a.hits.has(e))
        .map(({ idea, e }) => {
          const row = a.scores[e]!;
          const best = row.reduce((bi, s, i) => (s.score > row[bi]!.score ? i : bi), 0);
          return {
            extracted: idea.name,
            bestGold: row.length > 0 ? gold.ideas[best]!.name : null,
            bestScore: row.length > 0 ? round(row[best]!.score) : 0,
          };
        }),
      error: deck.error,
    });
  }

  const sum = (f: (d: DeckScore) => number) => perDeck.reduce((s, d) => s + f(d), 0);
  const goldN = sum((d) => d.gold);
  const extractedN = sum((d) => d.extracted);
  const hitsN = sum((d) => d.hits);
  const precision = ratio(hitsN, extractedN);
  const recall = ratio(hitsN, goldN);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  const typed = perDeck.filter((d) => d.deckType !== null);
  const isIdeaDeck = (t: DeckTypeLabel | null) => t === 'pitch' || t === 'creative_review';

  return {
    threshold,
    decks: perDeck.length,
    extractionErrors: perDeck.filter((d) => d.error !== null).length,
    extraction: {
      gold: goldN,
      extracted: extractedN,
      hits: hitsN,
      precision,
      recall,
      f1,
      duplicates: sum((d) => d.duplicates),
      nearMisses,
    },
    deckType: {
      accuracy: ratio(typed.filter((d) => d.deckType === d.goldDeckType).length, typed.length),
      gateAccuracy: ratio(
        typed.filter((d) => isIdeaDeck(d.deckType) === isIdeaDeck(d.goldDeckType)).length,
        typed.length,
      ),
      confusion,
      missedIdeaDecks: typed.filter((d) => isIdeaDeck(d.goldDeckType) && d.deckType === 'other')
        .length,
      falseIdeaDecks: typed.filter((d) => d.goldDeckType === 'other' && isIdeaDeck(d.deckType))
        .length,
    },
    merge: scoreMerge(run, keyOf),
    cost: {
      calls: run.calls.length,
      failedCalls: run.calls.filter((c) => !c.ok).length,
      spentUsd: run.spentUsd,
      stoppedByBudget: run.stoppedByBudget,
    },
    perDeck,
  };
}

/**
 * Walks the merge decisions in run order. A row's gold idea is that of the
 * extracted idea that created it; a merge is false when the incoming idea
 * belongs to another gold idea. Spurious ideas (no gold hit) make a merge
 * unscored rather than false or correct.
 */
function scoreMerge(run: RunFile, keyOf: Map<string, string>): ScoreReport['merge'] {
  const rowKey = new Map<string, string | null>();
  const rowAccount = new Map<string, string>();
  const rowMembers = new Map<string, Set<string>>();
  let correct = 0;
  let falseMerges = 0;
  let unscored = 0;
  let missed = 0;
  let matchErrors = 0;

  for (const d of run.merge.decisions) {
    const key = keyOf.get(`${d.deckId}#${d.ideaIndex}`) ?? null;
    if (d.action === 'create' || d.action === 'create_after_match_error') {
      if (d.action === 'create_after_match_error') matchErrors++;
      const existing = [...rowKey].some(
        ([row, k]) => key !== null && k === key && rowAccount.get(row) === d.account,
      );
      if (existing) missed++;
      rowKey.set(d.clusterId, key);
      rowAccount.set(d.clusterId, d.account);
    } else {
      const target = rowKey.get(d.clusterId) ?? null;
      if (key === null || target === null) unscored++;
      else if (key === target) correct++;
      else falseMerges++;
    }
    if (key !== null) {
      const members = rowMembers.get(d.clusterId) ?? new Set<string>();
      members.add(key);
      rowMembers.set(d.clusterId, members);
    }
  }

  const rowsPerKey = new Map<string, number>();
  for (const [row, k] of rowKey) {
    if (k === null) continue;
    const id = `${rowAccount.get(row)}\u0000${k}`;
    rowsPerKey.set(id, (rowsPerKey.get(id) ?? 0) + 1);
  }
  let nearDuplicateFacetPairs = 0;
  for (const c of run.merge.clusters) {
    for (let i = 0; i < c.facets.length; i++) {
      for (let j = i + 1; j < c.facets.length; j++) {
        if (trigramSimilarity(c.facets[i]!, c.facets[j]!) >= NEAR_DUPLICATE_FACET)
          nearDuplicateFacetPairs++;
      }
    }
  }

  return {
    ran: run.merge.ran,
    decisions: run.merge.decisions.length,
    scoredMerges: correct + falseMerges,
    correctMerges: correct,
    falseMerges,
    falseMergeRate: ratio(falseMerges, correct + falseMerges),
    unscoredMerges: unscored,
    missedMerges: missed,
    duplicateRows: [...rowsPerKey.values()].reduce((s, n) => s + n - 1, 0),
    impureRows: [...rowMembers.values()].filter((m) => m.size > 1).length,
    nearDuplicateFacetPairs,
    matchErrors,
  };
}

/** An error as one short line, for the progress output and the run file. */
export function oneLine(err: unknown): string {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 300);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

/** The stdout summary. */
export function formatReport(r: ScoreReport): string {
  const e = r.extraction;
  const m = r.merge;
  const lines = [
    `decks ${r.decks} (extraction errors ${r.extractionErrors}), threshold ${r.threshold}`,
    `extraction: precision ${pct(e.precision)}, recall ${pct(e.recall)}, F1 ${pct(e.f1)} ` +
      `(${e.hits} hits / ${e.extracted} extracted / ${e.gold} gold), duplicates ${e.duplicates}, near misses ${e.nearMisses.length}`,
    `deck type: accuracy ${pct(r.deckType.accuracy)}, gate ${pct(r.deckType.gateAccuracy)}, idea decks turned away ${r.deckType.missedIdeaDecks}, ` +
      `non-idea decks let through ${r.deckType.falseIdeaDecks}`,
  ];
  if (m.ran) {
    lines.push(
      `merge: false-merge rate ${pct(m.falseMergeRate)} (${m.falseMerges} of ${m.scoredMerges} scored, ${m.unscoredMerges} unscored), ` +
        `missed merges ${m.missedMerges}, duplicate rows ${m.duplicateRows}, impure rows ${m.impureRows}, ` +
        `near-duplicate facet pairs ${m.nearDuplicateFacetPairs}, match errors ${m.matchErrors}`,
    );
  } else {
    lines.push('merge: not run');
  }
  lines.push(
    `cost: ${r.cost.calls} calls (${r.cost.failedCalls} failed), $${r.cost.spentUsd.toFixed(4)}` +
      (r.cost.stoppedByBudget ? `; stopped: ${r.cost.stoppedByBudget}` : ''),
  );
  return lines.join('\n');
}
