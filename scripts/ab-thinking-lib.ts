/**
 * ab-thinking-lib.ts — the pure parts of scripts/ab-thinking.ts: prices,
 * the budget guard, record selection, output comparison and the summary.
 * No I/O and no model calls, so the unit suite covers them.
 */

/**
 * gemini-3.5-flash on the global endpoint, USD per 1M tokens (Cloud Billing
 * SKUs). Thoughts bill as output. Cached prompt tokens are priced as normal
 * input here, so cost figures are an upper bound.
 */
export const PRICE_PER_M_TOKENS = { input: 1.5, output: 9.0 } as const;

export const ARMS = ['default', 'MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type Arm = (typeof ARMS)[number];

export const KINDS = ['interpret', 'distill'] as const;
export type Kind = (typeof KINDS)[number];

/** The preset each kind replays. */
export const PRESET_KEY: Record<Kind, string> = {
  interpret: 'drive.file_extraction.v1',
  distill: 'drive.distillation.v1',
};

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

/** Output allowance assumed for a record captured without usage numbers. */
export const FALLBACK_OUTPUT_TOKENS = 8_000;

/**
 * Estimated cost of replaying one captured call. Uses the captured call's
 * own tokens (it ran at the default level, the most expensive arm in
 * practice), or ~4 characters per token plus FALLBACK_OUTPUT_TOKENS.
 */
export function estimateCellUsd(rec: {
  prompt: string;
  result: {
    usage: {
      promptTokens: number | null;
      outputTokens: number | null;
      thoughtsTokens: number | null;
    } | null;
  };
}): number {
  const u = rec.result.usage;
  return costUsd({
    promptTokens: u?.promptTokens ?? Math.ceil(rec.prompt.length / 4),
    outputTokens: u?.outputTokens ?? FALLBACK_OUTPUT_TOKENS,
    thoughtsTokens: u?.thoughtsTokens ?? 0,
  });
}

/** `n` items spread evenly over the list, in list order. */
export function selectEvenly<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  if (n <= 0) return [];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor((i * items.length) / n)]!);
  return out;
}

/** Spend guard: a cell runs only if its estimate still fits under the cap. */
export class Budget {
  spentUsd = 0;
  constructor(readonly maxUsd: number) {}
  allows(estimateUsd: number): boolean {
    return this.spentUsd + estimateUsd <= this.maxUsd;
  }
  add(usd: number): void {
    this.spentUsd += usd;
  }
}

/** JSON from a model answer, tolerating a ```json fence; undefined if none. */
export function parseJsonLoose(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(candidate.slice(start));
  } catch {
    return undefined;
  }
}

/** What an answer amounts to, for comparing arms on the same input. */
export interface OutputShape {
  valid: boolean;
  /** interpret: observations; distill: field changes + notes. */
  items: number;
  /**
   * What must not go missing against the default arm. distill: `field=value`
   * of each field change. interpret: the deck type and each campaign an
   * observation is routed to (wording varies run to run; routing should not).
   */
  keys: string[];
}

/** Shape of a valid interpret answer: observations, deck type, campaign routing. */
export function interpretShape(answer: {
  deck_type: string;
  account: readonly unknown[];
  campaign: ReadonlyArray<{ entity_campaign_name?: string | null | undefined }>;
}): OutputShape {
  const routed = new Set(
    answer.campaign
      .map((o) => o.entity_campaign_name?.trim().toLowerCase())
      .filter((name): name is string => Boolean(name))
      .map((name) => `campaign:${name}`),
  );
  return {
    valid: true,
    items: answer.account.length + answer.campaign.length,
    keys: [`deck:${answer.deck_type}`, ...routed],
  };
}

/** Shape of a valid distill answer: field changes + notes, keyed by field=value. */
export function distillShape(answer: {
  field_changes: ReadonlyArray<{ field: string; proposed_value?: string | null | undefined }>;
  notes: readonly unknown[];
}): OutputShape {
  return {
    valid: true,
    items: answer.field_changes.length + answer.notes.length,
    keys: answer.field_changes.map((c) => `${c.field}=${JSON.stringify(c.proposed_value ?? null)}`),
  };
}

export function compareShapes(
  base: OutputShape,
  arm: OutputShape,
): { itemsDelta: number; keysLost: string[]; keysAdded: string[] } {
  return {
    itemsDelta: arm.items - base.items,
    keysLost: base.keys.filter((k) => !arm.keys.includes(k)),
    keysAdded: arm.keys.filter((k) => !base.keys.includes(k)),
  };
}

export interface CellResult {
  kind: Kind;
  arm: Arm;
  recordIndex: number;
  ok: boolean;
  error: string | null;
  latencyMs: number;
  tokens: Tokens;
  usd: number;
  shape: OutputShape;
}

export interface ArmSummary {
  kind: Kind;
  arm: Arm;
  cells: number;
  failed: number;
  validShare: number;
  items: number;
  meanPromptTokens: number;
  meanOutputTokens: number;
  meanThoughtsTokens: number;
  meanLatencyMs: number;
  usd: number;
  /** Records this arm and the default arm both have: the comparison base. */
  pairedRecords: number;
  /** Items over the paired records, this arm and the default arm. */
  pairedItems: number;
  pairedBaseItems: number;
  /** Paired records that lost one or more keys against the default arm. */
  recordsLosingKeys: number;
}

export function summarize(cells: readonly CellResult[]): ArmSummary[] {
  const groups = new Map<string, CellResult[]>();
  for (const c of cells) {
    const k = `${c.kind}|${c.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const out: ArmSummary[] = [];
  for (const group of groups.values()) {
    const { kind, arm } = group[0]!;
    const baseline = cells.filter((c) => c.kind === kind && c.arm === 'default');
    let pairedRecords = 0;
    let pairedItems = 0;
    let pairedBaseItems = 0;
    let recordsLosingKeys = 0;
    for (const c of group) {
      const base = baseline.find((b) => b.recordIndex === c.recordIndex);
      if (!base) continue;
      pairedRecords++;
      pairedItems += c.shape.items;
      pairedBaseItems += base.shape.items;
      if (compareShapes(base.shape, c.shape).keysLost.length > 0) recordsLosingKeys++;
    }
    out.push({
      kind,
      arm,
      cells: group.length,
      failed: group.filter((c) => !c.ok).length,
      validShare: group.filter((c) => c.shape.valid).length / group.length,
      items: group.reduce((s, c) => s + c.shape.items, 0),
      meanPromptTokens: mean(group.map((c) => c.tokens.promptTokens)),
      meanOutputTokens: mean(group.map((c) => c.tokens.outputTokens)),
      meanThoughtsTokens: mean(group.map((c) => c.tokens.thoughtsTokens)),
      meanLatencyMs: mean(group.map((c) => c.latencyMs)),
      usd: group.reduce((s, c) => s + c.usd, 0),
      pairedRecords,
      pairedItems,
      pairedBaseItems,
      recordsLosingKeys,
    });
  }
  return out;
}

/**
 * The quality check, over the records this arm and the default arm both
 * have. An arm passes for a kind when every answer is valid, its item total
 * (observations, or field changes + notes) is within 10% of the default
 * arm's, and at most one record in ten (at least one) loses a key the
 * default arm had: a field change, a deck type or a campaign routing.
 */
export function verdict(summaries: readonly ArmSummary[]): string[] {
  const lines: string[] = [];
  for (const s of summaries) {
    if (s.arm === 'default') continue;
    const base = summaries.find((b) => b.kind === s.kind && b.arm === 'default');
    if (!base) {
      lines.push(`${s.kind} ${s.arm}: no default arm to compare with`);
      continue;
    }
    const itemsRatio =
      s.pairedBaseItems > 0
        ? s.pairedItems / s.pairedBaseItems
        : s.pairedItems === 0
          ? 1
          : Infinity;
    const allowedLosses = Math.max(1, Math.floor(s.pairedRecords / 10));
    const pass =
      s.pairedRecords > 0 &&
      s.validShare === 1 &&
      s.failed === 0 &&
      Math.abs(itemsRatio - 1) <= 0.1 &&
      s.recordsLosingKeys <= allowedLosses;
    const outputDrop =
      base.meanOutputTokens + base.meanThoughtsTokens > 0
        ? 1 -
          (s.meanOutputTokens + s.meanThoughtsTokens) /
            (base.meanOutputTokens + base.meanThoughtsTokens)
        : 0;
    lines.push(
      `${s.kind} ${s.arm}: ${pass ? 'PASS' : 'CHECK'} (valid ${(s.validShare * 100).toFixed(0)}%, ` +
        `items ${s.pairedItems} vs ${s.pairedBaseItems} over ${s.pairedRecords} paired record(s), ` +
        `records losing a key ${s.recordsLosingKeys} (allowed ${allowedLosses}), ` +
        `output+thoughts ${(outputDrop * 100).toFixed(0)}% below default)`,
    );
  }
  return lines;
}
