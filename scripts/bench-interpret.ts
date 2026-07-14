/**
 * bench-interpret.ts — measure the per-file interpret call: latency + token
 * split (prompt / thoughts / output) across thinkingBudget settings, on a
 * REAL deck. Quality proxies: observation count + deck_type.
 *
 *   DATABASE_URL=… npx tsx -r dotenv/config scripts/bench-interpret.ts <fileId> [runsPerConfig]
 */
import { prisma } from '../src/prisma';
import { defaultLlm, parseLlmJson } from '../src/ai';
import { perFileResponseSchema } from '../src/drive/structured-output';
import { extractText } from '../src/drive/extract';
import { driveClient } from '../src/drive/client';
import { config } from '../src/config';

const CONFIGS: Array<{ label: string; thinkingBudget?: number; thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' }> = [
  { label: 'default (model decides)' },
  { label: 'level MINIMAL', thinkingLevel: 'MINIMAL' },
  { label: 'level LOW', thinkingLevel: 'LOW' },
  { label: 'budget 0 (off)', thinkingBudget: 0 },
];

async function main(): Promise<void> {
  const fileId = process.argv[2];
  const runs = Number(process.argv[3] ?? '3');
  if (!fileId) throw new Error('pass a Drive file id');

  const preset = await prisma.promptPreset.findUniqueOrThrow({
    where: { key: 'drive.file_extraction.v1' },
    select: { template: true },
  });
  const drive = await driveClient();
  const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType,modifiedTime', supportsAllDrives: true });
  const file = {
    id: fileId, name: meta.data.name ?? '?', mimeType: meta.data.mimeType ?? '?',
    parents: [], path: `(bench) / ${meta.data.name}`, modifiedTime: meta.data.modifiedTime ?? null,
    modifiedByEmail: null, createdTime: null, size: null, isFolder: false,
  };
  const extraction = await extractText(file);
  if (extraction.kind !== 'ok') throw new Error(`extract failed: ${extraction.reason}`);
  const max = config.GEMINI_MAX_INPUT_CHARS;
  const fileText = extraction.text.length > max ? extraction.text.slice(0, max) : extraction.text;

  const vars: Record<string, string> = {
    account_name: 'Chevy',
    campaign_name: '02. Chevy | BHAC [GMCHV55000216]',
    known_campaigns_json: JSON.stringify(['02. Chevy | BHAC [GMCHV55000216]']),
    file_path: file.path,
    modified_time: file.modifiedTime ?? '(unknown)',
    modified_by: '(unknown)',
    file_text: fileText,
  };
  let prompt = preset.template;
  for (const [k, v] of Object.entries(vars)) prompt = prompt.replaceAll(`{{${k}}}`, v);

  console.log(`FILE: ${file.name}  ·  prompt ${prompt.length} chars (~${Math.round(prompt.length / 4)} tok)  ·  ${runs} run(s)/config\n`);
  console.log('config                     |  latency (each)       | thoughts | output | obs | deck_type');
  console.log('─'.repeat(100));

  for (const cfg of CONFIGS) {
    const lat: number[] = [];
    let thoughts: Array<number | null> = [];
    let outputs: Array<number | null> = [];
    let obsCounts: number[] = [];
    let deckTypes: string[] = [];
    let failed = '';
    for (let i = 0; i < runs; i++) {
      const t0 = Date.now();
      try {
        const res = await defaultLlm.complete({
          model: 'gemini-3.5-flash',
          temperature: 0.2,
          prompt,
          tag: 'bench.interpret',
          responseSchema: perFileResponseSchema(),
          ...(cfg.thinkingBudget !== undefined ? { thinkingBudget: cfg.thinkingBudget } : {}),
          ...(cfg.thinkingLevel !== undefined ? { thinkingLevel: cfg.thinkingLevel } : {}),
        });
        lat.push((Date.now() - t0) / 1000);
        thoughts.push(res.usage?.thoughtsTokens ?? null);
        outputs.push(res.usage?.outputTokens ?? null);
        try {
          const parsed = parseLlmJson<{ deck_type?: string; account?: unknown[]; campaign?: unknown[] }>(res.text);
          obsCounts.push((parsed.account?.length ?? 0) + (parsed.campaign?.length ?? 0));
          deckTypes.push(parsed.deck_type ?? '?');
        } catch {
          obsCounts.push(-1);
          deckTypes.push('PARSE-FAIL');
        }
      } catch (err) {
        failed = err instanceof Error ? err.message.slice(0, 60) : String(err);
        break;
      }
    }
    if (failed) {
      console.log(`${cfg.label.padEnd(26)} |  ERROR: ${failed}`);
      continue;
    }
    const latStr = lat.map((l) => `${l.toFixed(1)}s`).join(' ');
    const th = thoughts.map((t) => t ?? '—').join('/');
    const out = outputs.map((o) => o ?? '—').join('/');
    console.log(
      `${cfg.label.padEnd(26)} |  ${latStr.padEnd(20)} | ${th.padEnd(8)} | ${out.padEnd(6)} | ${obsCounts.join('/')}  | ${[...new Set(deckTypes)].join(',')}`,
    );
  }
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
