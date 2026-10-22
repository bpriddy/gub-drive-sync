/**
 * ab-thinking.ts — A/B of Gemini thinking levels on captured calls (#69).
 *
 * Replays captured interpret and distill prompts under several thinking
 * levels and records, per cell: tokens (thoughts included), latency, cost,
 * whether the answer passes the same validation the pipeline applies, and
 * how its observations or field changes compare with the default arm.
 *
 * PAID: every cell is one Gemini call (more if it is retried). Run it only
 * with an explicit go, and always with --max-usd.
 *
 * Inputs come from a local capture: run a scan with GEMINI_CAPTURE_DIR set
 * (src/ai/capture.ts), which writes `<dir>/<preset key>.jsonl`. Captured
 * prompts and the results file hold customer content, so both directories
 * must lie outside this repository; the script refuses otherwise.
 *
 * Usage (LOCAL only):
 *
 *   npm run ab-thinking -- --input <capture dir> --out <results dir> \
 *     --interpret 30 --distill 15 --arms default,LOW,MINIMAL --max-usd 8
 *
 *   --dry-run   print the plan and its estimated cost, call nothing.
 *
 * Output: `<out>/ab-thinking-<time>.jsonl` (one line per cell, answers
 * included), `<out>/ab-thinking-<time>-summary.json`, and a table plus a
 * PASS/CHECK line per kind and arm on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { defaultLlm } from '../src/ai/gemini.client';
import { llmUsageByTag } from '../src/ai/usage-tally';
import { isInside, packageRoot, type CapturedCall } from '../src/ai/capture';
import { PerFileResponseSchema } from '../src/drive/interpret';
import { DistillationSchema } from '../src/scan/persist';
import {
  ARMS,
  Budget,
  KINDS,
  PRESET_KEY,
  costUsd,
  distillShape,
  estimateCellUsd,
  interpretShape,
  parseJsonLoose,
  selectEvenly,
  summarize,
  verdict,
  type Arm,
  type CellResult,
  type Kind,
  type OutputShape,
  type Tokens,
} from './ab-thinking-lib';

interface Args {
  input: string;
  out: string;
  counts: Record<Kind, number>;
  arms: Arm[];
  maxUsd: number | null;
  dryRun: boolean;
}

function fail(message: string): never {
  console.error(`ab-thinking: ${message}`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = get('--input') ?? fail('--input <capture dir> is required');
  const out = get('--out') ?? fail('--out <results dir> is required');
  const arms = (get('--arms') ?? 'default,LOW,MINIMAL').split(',').map((a) => a.trim());
  for (const a of arms) {
    if (!(ARMS as readonly string[]).includes(a)) fail(`unknown arm ${a}; use ${ARMS.join(', ')}`);
  }
  const maxUsdRaw = get('--max-usd');
  const maxUsd = maxUsdRaw === undefined ? null : Number(maxUsdRaw);
  if (maxUsd !== null && !(maxUsd > 0)) fail('--max-usd must be a positive number');
  return {
    input,
    out,
    counts: {
      interpret: Number(get('--interpret') ?? 30),
      distill: Number(get('--distill') ?? 15),
    },
    arms: arms as Arm[],
    maxUsd,
    dryRun: argv.includes('--dry-run'),
  };
}

function refuseInsideRepo(dir: string, flag: string): void {
  if (isInside(dir, packageRoot(__dirname)) || isInside(dir, process.cwd())) {
    fail(`${flag} ${dir} is inside the repository; customer content must stay outside it`);
  }
}

function readCaptured(input: string, kind: Kind): CapturedCall[] {
  const file = path.join(input, `${PRESET_KEY[kind]}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CapturedCall);
}

/** Validate an answer the way the pipeline does, and reduce it to a shape. */
function shapeOf(kind: Kind, text: string): OutputShape {
  const json = parseJsonLoose(text);
  if (kind === 'interpret') {
    const r = PerFileResponseSchema.safeParse(json);
    return r.success ? interpretShape(r.data) : { valid: false, items: 0, keys: [] };
  }
  const r = DistillationSchema.safeParse(json);
  return r.success ? distillShape(r.data) : { valid: false, items: 0, keys: [] };
}

/** Tokens billed under `tag` since `before` (retried attempts included). */
function tokensSince(tag: string, before: Tokens): Tokens {
  const now = llmUsageByTag().find((t) => t.tag === tag);
  return {
    promptTokens: (now?.promptTokens ?? 0) - before.promptTokens,
    outputTokens: (now?.outputTokens ?? 0) - before.outputTokens,
    thoughtsTokens: (now?.thoughtsTokens ?? 0) - before.thoughtsTokens,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  refuseInsideRepo(args.input, '--input');
  refuseInsideRepo(args.out, '--out');

  const plan: Array<{ kind: Kind; recordIndex: number; record: CapturedCall; arm: Arm }> = [];
  for (const kind of KINDS) {
    const records = selectEvenly(readCaptured(args.input, kind), args.counts[kind]);
    console.log(`${kind}: ${records.length} captured record(s) selected`);
    records.forEach((record, recordIndex) => {
      for (const arm of args.arms) plan.push({ kind, recordIndex, record, arm });
    });
  }
  const estimate = plan.reduce((s, p) => s + estimateCellUsd(p.record), 0);
  console.log(
    `plan: ${plan.length} cell(s) over arms ${args.arms.join(', ')}; ` +
      `estimated at most $${estimate.toFixed(2)} (every arm priced like the captured default)`,
  );
  if (args.dryRun) return;
  if (args.maxUsd === null) fail('a live run needs --max-usd');
  if (defaultLlm.name === 'mock')
    fail('no Gemini credentials: the mock driver would fake the results');
  if (plan.length === 0) fail(`no captured records under ${args.input}`);

  fs.mkdirSync(args.out, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cellsFile = path.join(args.out, `ab-thinking-${stamp}.jsonl`);
  const budget = new Budget(args.maxUsd);
  const cells: CellResult[] = [];

  for (const p of plan) {
    const cellEstimate = estimateCellUsd(p.record);
    if (!budget.allows(cellEstimate)) {
      console.log(
        `budget: $${budget.spentUsd.toFixed(2)} spent, next cell estimated at $${cellEstimate.toFixed(3)}; stopping under --max-usd ${args.maxUsd}`,
      );
      break;
    }
    // An 'ab-thinking.' tag matches no GEMINI_THINKING_BY_TAG call type, so
    // the default arm really runs at the model's default level.
    const tag = `ab-thinking.${p.kind}`;
    const prior = llmUsageByTag().find((t) => t.tag === tag);
    const before: Tokens = {
      promptTokens: prior?.promptTokens ?? 0,
      outputTokens: prior?.outputTokens ?? 0,
      thoughtsTokens: prior?.thoughtsTokens ?? 0,
    };
    const started = Date.now();
    let text = '';
    let error: string | null = null;
    try {
      const res = await defaultLlm.complete({
        model: p.record.model,
        temperature: p.record.temperature,
        prompt: p.record.prompt,
        tag,
        ...(p.record.responseSchema ? { responseSchema: p.record.responseSchema } : {}),
        ...(p.record.timeoutMs !== null ? { timeoutMs: p.record.timeoutMs } : {}),
        ...(p.arm === 'default' ? {} : { thinkingLevel: p.arm }),
      });
      text = res.text;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const tokens = tokensSince(tag, before);
    const usd = costUsd(tokens);
    budget.add(usd);
    const cell: CellResult = {
      kind: p.kind,
      arm: p.arm,
      recordIndex: p.recordIndex,
      ok: error === null,
      error,
      latencyMs: Date.now() - started,
      tokens,
      usd,
      shape: error === null ? shapeOf(p.kind, text) : { valid: false, items: 0, keys: [] },
    };
    cells.push(cell);
    fs.appendFileSync(cellsFile, JSON.stringify({ ...cell, text }) + '\n', { mode: 0o600 });
    console.log(
      `${p.kind} #${p.recordIndex} ${p.arm}: ${cell.ok ? 'ok' : `error (${error})`}, ` +
        `${tokens.thoughtsTokens} thoughts, ${cell.latencyMs} ms, $${usd.toFixed(4)}, total $${budget.spentUsd.toFixed(2)}`,
    );
  }

  const summaries = summarize(cells);
  const lines = verdict(summaries);
  fs.writeFileSync(
    path.join(args.out, `ab-thinking-${stamp}-summary.json`),
    JSON.stringify({ args, spentUsd: budget.spentUsd, summaries, verdict: lines }, null, 2),
    { mode: 0o600 },
  );
  console.table(summaries);
  for (const line of lines) console.log(line);
  console.log(`spent $${budget.spentUsd.toFixed(2)} of $${args.maxUsd}; cells in ${cellsFile}`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
