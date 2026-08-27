/**
 * eval-vision-extraction.ts — C1 (#34) side-by-side eval: Gemini vision
 * extraction vs the unpdf text-layer baseline, on ONE real account's PDFs.
 *
 * For each sampled PDF (freshest snapshot per fileId, spread across sizes):
 *   1. download once
 *   2. text-layer path (unpdf)  — timed
 *   3. vision path (visionExtractPdf) — timed, token usage recorded
 *   4. quality judge: one more vision call sees the PDF + BOTH transcripts
 *      and scores each 0–10 on information completeness (text, tables,
 *      charts/visuals) and structure fidelity
 * Prints a markdown table (for the PR) plus totals.
 *
 * Usage:
 *   npx tsx scripts/eval-vision-extraction.ts                 # list accounts by PDF count
 *   npx tsx scripts/eval-vision-extraction.ts --account acme --limit 8 \
 *     --price-in 0.30 --price-out 2.50                        # $/1M tokens
 *
 * Env: DATABASE_URL, GUB_BOT_OAUTH_CLIENT_ID/SECRET, and Gemini auth
 * (GEMINI_USE_ENTERPRISE=true + GCP_PROJECT_ID, or GEMINI_API_KEY).
 * Read-only against Drive; writes nothing to the DB.
 */

import { prisma } from '../src/prisma';
import { downloadFileBuffer, getFileMetadata } from '../src/drive/client';
import { visionExtractPdf, countPdfPages } from '../src/drive/extract-vision';
import { defaultLlm, SchemaType, type ResponseSchema } from '../src/ai';
import { config } from '../src/config';

interface Args {
  account: string | undefined;
  limit: number;
  priceIn: number; // $ per 1M input tokens
  priceOut: number; // $ per 1M output tokens
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    account: get('--account'),
    limit: Number(get('--limit') ?? 8),
    priceIn: Number(get('--price-in') ?? 0),
    priceOut: Number(get('--price-out') ?? 0),
  };
}

async function listAccounts(): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ name: string; id: string; pdfs: bigint }>>`
    select a.name, a.id, count(distinct s.file_id) as pdfs
    from drive_file_snapshots s
    join accounts a on a.id = s.account_id
    where s.mime_type = 'application/pdf'
    group by a.name, a.id
    order by pdfs desc
    limit 15`;
  console.log('Accounts by distinct PDF count:');
  for (const r of rows) console.log(`  ${String(r.pdfs).padStart(4)}  ${r.name}  (${r.id})`);
}

interface Sampled {
  fileId: string;
  name: string;
  sizeBytes: number | null;
}

async function samplePdfs(accountNeedle: string, limit: number): Promise<Sampled[]> {
  const account = await prisma.account.findFirst({
    where: { name: { contains: accountNeedle, mode: 'insensitive' } },
    select: { id: true, name: true },
  });
  if (!account) throw new Error(`no account matching "${accountNeedle}"`);
  console.log(`Account: ${account.name} (${account.id})\n`);

  const rows = await prisma.$queryRaw<Array<{ file_id: string; name: string; size_bytes: bigint | null }>>`
    select distinct on (file_id) file_id, name, size_bytes
    from drive_file_snapshots
    where account_id = ${account.id}::uuid and mime_type = 'application/pdf'
    order by file_id, scanned_at desc`;

  // Vision-eligible only (the eval compares the two paths; over-cap files
  // exercise the fallback, which the unit tests already pin).
  const eligible = rows
    .filter((r) => r.size_bytes !== null && Number(r.size_bytes) <= config.DRIVE_VISION_MAX_FILE_SIZE_BYTES)
    .sort((a, b) => Number(a.size_bytes) - Number(b.size_bytes));
  if (eligible.length === 0) throw new Error('no vision-eligible PDFs for this account');

  // Even spread across the size range.
  const picked: Sampled[] = [];
  const step = Math.max(1, Math.floor(eligible.length / limit));
  for (let i = 0; i < eligible.length && picked.length < limit; i += step) {
    const r = eligible[i]!;
    picked.push({ fileId: r.file_id, name: r.name, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes) });
  }
  return picked;
}

const JUDGE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    textLayerScore: { type: SchemaType.NUMBER },
    visionScore: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['textLayerScore', 'visionScore', 'notes'],
};

async function judge(
  buf: Buffer,
  textLayer: string,
  vision: string,
): Promise<{ textLayerScore: number; visionScore: number; notes: string }> {
  const clip = (s: string) => (s.length > 12000 ? s.slice(0, 12000) + '\n…[clipped]' : s);
  const res = await defaultLlm.complete({
    model: config.DRIVE_VISION_MODEL || 'gemini-3.5-flash',
    temperature: 0,
    prompt: `The attached PDF was transcribed by two different extractors. Score EACH transcription 0-10 on how completely it captures the document's information: body text, tables, and content that only exists visually (charts, diagrams, designed layouts). Structure fidelity (section/page markers, reading order) counts. A transcription missing content that is clearly present in the PDF must lose points.

=== TRANSCRIPTION A (text-layer) ===
${clip(textLayer)}

=== TRANSCRIPTION B (vision) ===
${clip(vision)}`,
    media: [{ mimeType: 'application/pdf', dataBase64: buf.toString('base64') }],
    responseSchema: JUDGE_SCHEMA,
    maxOutputTokens: 4096,
    timeoutMs: config.DRIVE_VISION_TIMEOUT_MS,
    tag: 'eval.vision_judge',
  });
  return JSON.parse(res.text) as { textLayerScore: number; visionScore: number; notes: string };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.account) {
    await listAccounts();
    return;
  }
  const files = await samplePdfs(args.account, args.limit);
  console.log(`Sampled ${files.length} vision-eligible PDFs.\n`);

  const rows: string[] = [];
  let totPromptTok = 0;
  let totOutTok = 0;
  let totThoughtTok = 0;

  for (const f of files) {
    const meta = await getFileMetadata(f.fileId);
    if (!meta) {
      console.log(`  SKIP (gone from Drive): ${f.name}`);
      continue;
    }
    const buf = await downloadFileBuffer(f.fileId);
    const pages = await countPdfPages(buf);

    // Text-layer baseline (same code path as extract.ts's fallback).
    const t0 = Date.now();
    let textLayer = '';
    let textErr: string | null = null;
    try {
      const { getDocumentProxy, extractText } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 });
      textLayer = (await extractText(pdf, { mergePages: true })).text.trim();
    } catch (e) {
      textErr = String(e).slice(0, 80);
    }
    const textMs = Date.now() - t0;

    // Vision path.
    const t1 = Date.now();
    let vision = '';
    let visionErr: string | null = null;
    let usage: { promptTokens: number | null; outputTokens: number | null; thoughtsTokens: number | null } | undefined;
    try {
      const r = await visionExtractPdf(buf);
      vision = r.text;
      usage = r.usage;
    } catch (e) {
      visionErr = String(e).slice(0, 120);
    }
    const visionMs = Date.now() - t1;

    totPromptTok += usage?.promptTokens ?? 0;
    totOutTok += usage?.outputTokens ?? 0;
    totThoughtTok += usage?.thoughtsTokens ?? 0;

    // Quality judge (skipped when either side failed).
    let scores = { textLayerScore: NaN, visionScore: NaN, notes: textErr ?? visionErr ?? '' };
    if (!textErr && !visionErr) {
      try {
        scores = await judge(buf, textLayer, vision);
      } catch (e) {
        scores.notes = `judge failed: ${String(e).slice(0, 80)}`;
      }
    }

    const outTokBillable = (usage?.outputTokens ?? 0) + (usage?.thoughtsTokens ?? 0);
    const cost =
      args.priceIn && usage?.promptTokens
        ? (usage.promptTokens / 1e6) * args.priceIn + (outTokBillable / 1e6) * args.priceOut
        : null;

    rows.push(
      `| ${f.name.slice(0, 40)} | ${pages ?? '?'} | ${((buf.length / 1024) | 0)} KB | ` +
        `${textLayer.length} ch / ${textMs} ms | ` +
        `${visionErr ? 'ERR' : vision.length + ' ch'} / ${(visionMs / 1000).toFixed(1)} s | ` +
        `${usage?.promptTokens ?? '—'} / ${outTokBillable || '—'} | ` +
        `${cost === null ? '—' : '$' + cost.toFixed(4)} | ` +
        `${Number.isNaN(scores.textLayerScore) ? '—' : scores.textLayerScore} → ${Number.isNaN(scores.visionScore) ? '—' : scores.visionScore} | ` +
        `${scores.notes.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 110)} |`,
    );
    console.log(`  done: ${f.name} (${pages} pages, vision ${(visionMs / 1000).toFixed(1)}s)`);
  }

  console.log('\n| File | Pages | Size | Text-layer (chars/latency) | Vision (chars/latency) | Vision tokens in/out | Vision cost | Quality text→vision (0-10) | Judge notes |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  const totCost = args.priceIn
    ? (totPromptTok / 1e6) * args.priceIn + ((totOutTok + totThoughtTok) / 1e6) * args.priceOut
    : null;
  console.log(
    `\nTotals: prompt=${totPromptTok} output=${totOutTok} thoughts=${totThoughtTok} tokens` +
      (totCost === null ? '' : `; est. cost $${totCost.toFixed(4)} (${rows.length} files)`),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
