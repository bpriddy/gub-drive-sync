/**
 * eval-ideas.ts — extraction and merge quality of the ideas pipeline (#70),
 * measured against a gold set.
 *
 * Two modes:
 *   extract  PAID. Runs the production idea extractor on every fixture deck,
 *            then the production matcher over the extracted ideas, account
 *            by account in deck order (the same loop as the scan's
 *            mergeIdeaCandidates, in memory: no database). Saves the outputs
 *            and scores them. Every call is one Gemini request: run it only
 *            with an explicit go, and always with --max-usd.
 *   score    $0. Scores a saved run against the fixtures' gold files, so the
 *            gold set and the threshold can change without a new run.
 *
 * `extract --plan` builds every extraction prompt (and a matcher prompt per
 * gold idea) with the model call stubbed out, and prints the call count and
 * the cost estimate. It calls nothing.
 *
 * Fixtures and outputs hold customer content (deck text, idea text), so both
 * must lie outside this repository; the script refuses otherwise. The one
 * exception is the synthetic example set in scripts/eval-ideas-example.
 * The README ("Ideas eval") describes the fixture format and how to build a
 * gold set.
 *
 * Usage (LOCAL only):
 *
 *   npm run eval-ideas -- extract --fixtures <dir> --plan
 *   npm run eval-ideas -- extract --fixtures <dir> --out <dir> --max-usd 3 [--limit N] [--no-merge]
 *   npm run eval-ideas -- score --fixtures <dir> --run <run file> [--out <dir>]
 *
 *   --threshold <0..1>   hit threshold for the fuzzy match (default 0.4)
 *   --allow-mock         let extract run on the mock driver (no Gemini set up): a $0 smoke
 *                        test of the plumbing; the mock's empty deck_type fails the
 *                        extractor's parse, so every deck records an error
 *
 * EVAL_IDEAS_FIXTURES and EVAL_IDEAS_OUT stand in for --fixtures and --out.
 *
 * Output: `<out>/eval-ideas-<time>.json` (the run: every call's tokens and
 * cost, every deck's extracted ideas, every merge decision), and
 * `<run>-score.json` (the metrics, per deck too); a summary on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { TraversedFile } from '../src/drive/types';
import {
  Budget,
  BudgetStop,
  accountOf,
  costUsd,
  formatReport,
  oneLine,
  runMergeStage,
  guardDriver,
  isInside,
  isRunFile,
  loadFixtures,
  parseArgs,
  score,
  type Args,
  type DeckRun,
  type FixtureDeck,
  type RunFile,
} from './eval-ideas-lib';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE_DIR = path.join(__dirname, 'eval-ideas-example');

/** Output allowance (thoughts included) per call assumed by --plan: an assumption until a run measures it. */
const PLAN_OUTPUT_TOKENS = 2_500;

function fail(msg: string): never {
  console.error(`eval-ideas: ${msg}`);
  process.exit(1);
}

/** Customer content stays out of the repo: fixtures (bar the synthetic example) and every output. */
function checkPaths(args: Args): void {
  if (isInside(args.fixtures, REPO_ROOT) && !isInside(args.fixtures, EXAMPLE_DIR)) {
    fail(`--fixtures ${args.fixtures} is inside the repository; keep fixtures outside it`);
  }
  if (args.out !== null && isInside(args.out, REPO_ROOT)) {
    fail(
      `--out ${args.out} is inside the repository; outputs hold idea text, keep them outside it`,
    );
  }
}

/** The production modules, loaded only for extract: config needs env, and score must run without it. */
async function loadPipeline(stubModel: boolean) {
  if (stubModel) {
    // --plan: whatever the environment says, the driver is the mock one.
    process.env['GEMINI_USE_ENTERPRISE'] = 'false';
    process.env['GEMINI_API_KEY'] = '';
  }
  // config.ts requires DATABASE_URL at import; nothing here opens a connection.
  process.env['DATABASE_URL'] ||= 'postgresql://unused@localhost:1/unused';
  const ai = await import('../src/ai');
  const extraction = await import('../src/drive/idea-extraction');
  const matcher = await import('../src/drive/idea-matcher');
  const runner = await import('../src/drive/idea-runner');
  return {
    llm: ai.defaultLlm,
    model: ai.DEFAULT_GEMINI_MODEL,
    extractIdeasFromFile: extraction.extractIdeasFromFile,
    matchAndMergeIdea: matcher.matchAndMergeIdea,
    facetsEqual: runner.facetsEqual,
  };
}

function fileOf(deck: FixtureDeck): TraversedFile {
  return {
    id: deck.id,
    name: deck.gold.name ?? deck.id,
    mimeType: 'application/vnd.google-apps.presentation',
    path: deck.gold.path ?? '',
    modifiedTime: null,
    modifiedByEmail: null,
    createdTime: null,
    size: null,
    isFolder: false,
  };
}

async function plan(args: Args, decks: FixtureDeck[]): Promise<void> {
  const p = await loadPipeline(true);
  const prompts: Array<{ tag: string; promptTokens: number; maxOutputTokens: number }> = [];
  p.llm.complete = async (req) => {
    prompts.push({
      tag: req.tag ?? '(untagged)',
      promptTokens: Math.ceil(Buffer.byteLength(req.prompt, 'utf8') / 3),
      maxOutputTokens: req.maxOutputTokens ?? 65_536,
    });
    const text = req.tag?.includes('match')
      ? '{"match_index":0,"merged_facets":[]}'
      : '{"deck_type":"other","ideas":[]}';
    return { text, driver: 'plan-stub', model: req.model };
  };

  for (const deck of decks) {
    await p.extractIdeasFromFile({
      file: fileOf(deck),
      text: deck.text,
      accountName: deck.gold.account ?? null,
    });
  }
  // Matcher prompts, sized as if every gold idea arrived and none merged:
  // the candidate list then grows the fastest, so this errs high.
  if (args.merge) {
    const known = new Map<string, Array<{ id: string; name: string; facets: string[] }>>();
    for (const deck of decks) {
      const rows = known.get(accountOf(deck)) ?? [];
      known.set(accountOf(deck), rows);
      for (const idea of deck.gold.ideas) {
        await p.matchAndMergeIdea({
          newIdea: { name: idea.name, facets: idea.facets },
          existingIdeas: rows,
          accountName: deck.gold.account ?? null,
        });
        rows.push({ id: `plan:${rows.length}`, name: idea.name, facets: idea.facets });
      }
    }
  }

  const byTag = new Map<
    string,
    { calls: number; promptTokens: number; worstUsd: number; expectedUsd: number }
  >();
  for (const c of prompts) {
    const t = byTag.get(c.tag) ?? { calls: 0, promptTokens: 0, worstUsd: 0, expectedUsd: 0 };
    t.calls++;
    t.promptTokens += c.promptTokens;
    t.expectedUsd += costUsd({
      promptTokens: c.promptTokens,
      outputTokens: PLAN_OUTPUT_TOKENS,
      thoughtsTokens: 0,
    });
    t.worstUsd += costUsd({
      promptTokens: c.promptTokens,
      outputTokens: c.maxOutputTokens,
      thoughtsTokens: 0,
    });
    byTag.set(c.tag, t);
  }
  const ideaDecks = decks.filter((d) => d.gold.deckType !== 'other').length;
  const goldIdeas = decks.reduce((s, d) => s + d.gold.ideas.length, 0);
  console.log(
    `plan: ${decks.length} decks (${ideaDecks} idea decks by gold), ${goldIdeas} gold ideas; no call made`,
  );
  let expected = 0;
  let worst = 0;
  for (const [tag, t] of byTag) {
    expected += t.expectedUsd;
    worst += t.worstUsd;
    console.log(
      `  ${tag}: ${t.calls} calls, ~${t.promptTokens.toLocaleString('en-US')} prompt tokens (est.), ` +
        `expected $${t.expectedUsd.toFixed(2)} at ${PLAN_OUTPUT_TOKENS} output+thought tokens/call, worst $${t.worstUsd.toFixed(2)}`,
    );
  }
  console.log(
    `  total: expected ~$${expected.toFixed(2)}, worst case $${worst.toFixed(2)} (every call at its full output allowance)`,
  );
  console.log(
    '  matcher calls are sized from the gold ideas; the real count follows what the extractor returns',
  );
}

async function extract(args: Args, decks: FixtureDeck[]): Promise<void> {
  if (args.maxUsd === null) fail('extract needs --max-usd');
  if (args.out === null) fail('extract needs --out <dir> (or EVAL_IDEAS_OUT)');
  const p = await loadPipeline(false);
  const free = p.llm.name === 'mock';
  if (free && !args.allowMock) {
    fail(
      'no Gemini driver is configured (the mock would return empty answers); pass --allow-mock for a smoke test',
    );
  }
  console.log(`driver ${p.llm.name}, model ${p.model}, ${decks.length} decks, cap $${args.maxUsd}`);

  const budget = new Budget(args.maxUsd);
  const run: RunFile = {
    version: 1,
    kind: 'eval-ideas-run',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    driver: p.llm.name,
    model: p.model,
    maxUsd: args.maxUsd,
    spentUsd: 0,
    stoppedByBudget: null,
    calls: [],
    decks: [],
    merge: { ran: false, decisions: [], clusters: [] },
  };
  guardDriver(p.llm, budget, run.calls, free);

  fs.mkdirSync(args.out, { recursive: true });
  const runPath = path.join(
    path.resolve(args.out),
    `eval-ideas-${run.startedAt.replace(/[:.]/g, '-')}.json`,
  );
  // Write-then-rename, so a kill mid-write never leaves a truncated run file.
  const save = () => {
    run.spentUsd = budget.spentUsd;
    fs.writeFileSync(`${runPath}.tmp`, JSON.stringify(run, null, 2));
    fs.renameSync(`${runPath}.tmp`, runPath);
  };

  for (const [i, deck] of decks.entries()) {
    const deckRun: DeckRun = { id: deck.id, deckType: null, ideas: [], error: null };
    try {
      const res = await p.extractIdeasFromFile({
        file: fileOf(deck),
        text: deck.text,
        accountName: deck.gold.account ?? null,
      });
      deckRun.deckType = res.deckType;
      deckRun.ideas = res.ideas;
    } catch (err) {
      if (err instanceof BudgetStop) {
        run.stoppedByBudget = err.message;
        break;
      }
      deckRun.error = oneLine(err);
    }
    run.decks.push(deckRun);
    save();
    console.log(
      `[${i + 1}/${decks.length}] ${deck.id}: ${deckRun.error ? `error ${deckRun.error}` : `${deckRun.deckType}, ${deckRun.ideas.length} ideas`}, total $${budget.spentUsd.toFixed(4)}`,
    );
  }

  if (args.merge && run.stoppedByBudget === null) {
    run.merge.ran = true;
    await runMergeStage(p, decks, run, save);
    save();
  }

  run.finishedAt = new Date().toISOString();
  save();
  console.log(`run saved: ${runPath}`);
  writeScore(args, decks, run, runPath);
}

function writeScore(args: Args, decks: FixtureDeck[], run: RunFile, runPath: string): void {
  const report = score(decks, run, args.threshold);
  const base = path.basename(runPath, '.json');
  const dir = args.out !== null ? path.resolve(args.out) : path.dirname(runPath);
  if (isInside(dir, REPO_ROOT))
    fail(`the score file would land inside the repository (${dir}); pass --out`);
  fs.mkdirSync(dir, { recursive: true });
  const scorePath = path.join(dir, `${base}-score.json`);
  fs.writeFileSync(scorePath, JSON.stringify(report, null, 2));
  console.log(formatReport(report));
  console.log(`score saved: ${scorePath}`);
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  checkPaths(args);
  const all = loadFixtures(args.fixtures);
  const decks = args.limit !== null ? all.slice(0, args.limit) : all;

  if (args.mode === 'score') {
    if (args.run === null) fail('score needs --run <run file>');
    const run: unknown = JSON.parse(fs.readFileSync(args.run, 'utf8'));
    if (!isRunFile(run)) fail(`${args.run} is not an eval-ideas run file`);
    writeScore(args, all, run, path.resolve(args.run));
    return;
  }
  if (args.plan) return plan(args, decks);
  return extract(args, decks);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
