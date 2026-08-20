/**
 * eval-image-vision.ts — C2 (#35) yield eval: Gemini vision extraction on
 * the images the C2 gate would actually admit — the ones inside
 * folder-backed piece folders, within the size floor/cap.
 *
 * There is no baseline to compare against (pre-C2, images extract to
 * nothing at all), so unlike the C1 eval this measures YIELD:
 *   - scope: how many images live in piece scope at all (default mode)
 *   - per admitted image: transcription length, emptiness, latency,
 *     token usage/cost, plus a vision judge scoring how completely the
 *     transcription captures the image's marketing-relevant content
 * Prints a markdown table (for the PR) plus totals.
 *
 * Usage:
 *   npx tsx scripts/eval-image-vision.ts                # scope table: images per piece
 *   npx tsx scripts/eval-image-vision.ts --piece BHAC --limit 8 \
 *     --price-in 0.30 --price-out 2.50                  # $/1M tokens
 *
 * Env: DATABASE_URL, GUB_BOT_OAUTH_CLIENT_ID/SECRET, and Gemini auth
 * (GEMINI_USE_ENTERPRISE=true + GCP_PROJECT_ID, or GEMINI_API_KEY).
 * Read-only against Drive; writes nothing to the DB.
 */

import { prisma } from '../src/prisma';
import { downloadFileBuffer, getFileMetadata } from '../src/drive/client';
import { visionExtractImage } from '../src/drive/extract-vision';
import { isVisionEligibleImageMime } from '../src/drive/image-mimes';
import { defaultLlm, SchemaType, type ResponseSchema } from '../src/ai';
import { config } from '../src/config';

interface Args {
  piece: string | undefined;
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
    piece: get('--piece'),
    limit: Number(get('--limit') ?? 8),
    priceIn: Number(get('--price-in') ?? 0),
    priceOut: Number(get('--price-out') ?? 0),
  };
}

/** Scope table: every folder-backed piece and its image population. */
async function listPieces(): Promise<void> {
  const rows = await prisma.$queryRaw<
    Array<{ piece: string; campaign: string; imgs: bigint; in_caps: bigint }>
  >`
    select p.name as piece, c.name as campaign,
           count(distinct s.file_id) as imgs,
           count(distinct s.file_id) filter (
             where s.size_bytes >= ${config.DRIVE_IMAGE_MIN_FILE_SIZE_BYTES}
               and s.size_bytes <= ${config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES}
           ) as in_caps
    from campaign_pieces p
    join campaigns c on c.id = p.campaign_id
    left join drive_file_snapshots s
      on s.path like p.drive_folder_path || ' / %' and s.mime_type like 'image/%'
    where p.drive_folder_path is not null
    group by p.name, c.name
    order by imgs desc`;
  const total = await prisma.$queryRaw<Array<{ n: bigint }>>`
    select count(distinct file_id) as n from drive_file_snapshots where mime_type like 'image/%'`;
  console.log(`Images account-wide (all accounts): ${total[0]?.n ?? 0}`);
  console.log('Folder-backed pieces and their image populations (size floor/cap applied):');
  for (const r of rows) {
    console.log(
      `  ${String(r.imgs).padStart(4)} imgs (${String(r.in_caps).padStart(3)} in caps)  ` +
        `${r.campaign} / ${r.piece}`,
    );
  }
}

interface Sampled {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
}

async function samplePieceImages(pieceNeedle: string, limit: number): Promise<Sampled[]> {
  const piece = await prisma.campaignPiece.findFirst({
    where: {
      name: { contains: pieceNeedle, mode: 'insensitive' },
      driveFolderPath: { not: null },
    },
    select: { name: true, driveFolderPath: true },
  });
  if (!piece) throw new Error(`no folder-backed piece matching "${pieceNeedle}"`);
  console.log(`Piece: ${piece.name}\nFolder: ${piece.driveFolderPath}\n`);

  const rows = await prisma.$queryRaw<
    Array<{ file_id: string; name: string; mime_type: string; size_bytes: bigint | null }>
  >`
    select distinct on (file_id) file_id, name, mime_type, size_bytes
    from drive_file_snapshots
    where path like ${piece.driveFolderPath + ' / %'} and mime_type like 'image/%'
    order by file_id, scanned_at desc`;

  // Exactly the C2 gate population: eligible mime + within floor/cap.
  const eligible = rows
    .filter((r) => isVisionEligibleImageMime(r.mime_type))
    .filter(
      (r) =>
        r.size_bytes !== null &&
        Number(r.size_bytes) >= config.DRIVE_IMAGE_MIN_FILE_SIZE_BYTES &&
        Number(r.size_bytes) <= config.DRIVE_IMAGE_MAX_FILE_SIZE_BYTES,
    )
    .sort((a, b) => Number(a.size_bytes) - Number(b.size_bytes));
  console.log(
    `${rows.length} image(s) under the piece folder; ${eligible.length} pass mime + floor/cap gates.`,
  );
  if (eligible.length === 0) throw new Error('no gate-passing images for this piece');

  // Even spread across the size range (same trick as the C1 eval).
  const picked: Sampled[] = [];
  const step = Math.max(1, Math.floor(eligible.length / limit));
  for (let i = 0; i < eligible.length && picked.length < limit; i += step) {
    const r = eligible[i]!;
    picked.push({
      fileId: r.file_id,
      name: r.name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    });
  }
  return picked;
}

const JUDGE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    score: { type: SchemaType.NUMBER },
    notes: { type: SchemaType.STRING },
  },
  required: ['score', 'notes'],
};

async function judge(
  mimeType: string,
  buf: Buffer,
  transcription: string,
): Promise<{ score: number; notes: string }> {
  const clip = (s: string) => (s.length > 12000 ? s.slice(0, 12000) + '\n…[clipped]' : s);
  const res = await defaultLlm.complete({
    model: config.DRIVE_VISION_MODEL || 'gemini-3.5-flash',
    temperature: 0,
    prompt: `The attached image was transcribed for a marketing-intelligence pipeline. Score the transcription 0-10 on how completely it captures the image's marketing-relevant content: legible text (headlines, body copy, CTAs, disclaimers), identifiable brand elements, and what the visual actually depicts. A transcription missing content clearly present in the image must lose points; an empty transcription of a content-free image (pure chrome) scores 10.

=== TRANSCRIPTION ===
${clip(transcription) || '(empty)'}`,
    media: [{ mimeType, dataBase64: buf.toString('base64') }],
    responseSchema: JUDGE_SCHEMA,
    maxOutputTokens: 4096,
    timeoutMs: config.DRIVE_VISION_TIMEOUT_MS,
    tag: 'eval.image_vision_judge',
  });
  return JSON.parse(res.text) as { score: number; notes: string };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!args.piece) {
    await listPieces();
    await prisma.$disconnect();
    return;
  }
  const files = await samplePieceImages(args.piece, args.limit);
  console.log(`Sampled ${files.length} gate-passing image(s).\n`);

  const rows: string[] = [];
  let totPromptTok = 0;
  let totOutTok = 0;
  let totThoughtTok = 0;
  let nonEmpty = 0;

  for (const f of files) {
    const meta = await getFileMetadata(f.fileId);
    if (!meta) {
      console.log(`  SKIP (gone from Drive): ${f.name}`);
      continue;
    }
    const buf = await downloadFileBuffer(f.fileId);

    const t0 = Date.now();
    let text = '';
    let visionErr: string | null = null;
    let usage:
      | { promptTokens: number | null; outputTokens: number | null; thoughtsTokens: number | null }
      | undefined;
    try {
      const r = await visionExtractImage(f.mimeType, buf);
      text = r.text;
      usage = r.usage;
    } catch (e) {
      visionErr = String(e).slice(0, 120);
    }
    const visionMs = Date.now() - t0;
    if (text.length > 0) nonEmpty += 1;

    totPromptTok += usage?.promptTokens ?? 0;
    totOutTok += usage?.outputTokens ?? 0;
    totThoughtTok += usage?.thoughtsTokens ?? 0;

    let scores = { score: NaN, notes: visionErr ?? '' };
    if (!visionErr) {
      try {
        scores = await judge(f.mimeType, buf, text);
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
      `| ${f.name.slice(0, 40)} | ${f.mimeType.slice(6)} | ${((buf.length / 1024) | 0)} KB | ` +
        `${visionErr ? 'ERR' : text.length + ' ch'} / ${(visionMs / 1000).toFixed(1)} s | ` +
        `${usage?.promptTokens ?? '—'} / ${outTokBillable || '—'} | ` +
        `${cost === null ? '—' : '$' + cost.toFixed(4)} | ` +
        `${Number.isNaN(scores.score) ? '—' : scores.score} | ` +
        `${scores.notes.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 110)} |`,
    );
    console.log(`  done: ${f.name} (${text.length} ch, ${(visionMs / 1000).toFixed(1)}s)`);
  }

  console.log(
    '\n| File | Mime | Size | Vision (chars/latency) | Tokens in/out | Cost | Judge (0-10) | Judge notes |',
  );
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  const totCost = args.priceIn
    ? (totPromptTok / 1e6) * args.priceIn + ((totOutTok + totThoughtTok) / 1e6) * args.priceOut
    : null;
  console.log(
    `\nYield: ${nonEmpty}/${rows.length} non-empty transcription(s).` +
      `\nTotals: prompt=${totPromptTok} output=${totOutTok} thoughts=${totThoughtTok} tokens` +
      (totCost === null ? '' : `; est. cost $${totCost.toFixed(4)} (${rows.length} files)`),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
