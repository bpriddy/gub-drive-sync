/** render-interpret-prompt.ts — render the EXACT per-file interpret prompt for
 *  a real file (no LLM call). Shows what a 26-second call is actually reading.
 *    DATABASE_URL=… npx tsx -r dotenv/config scripts/render-interpret-prompt.ts <fileId>
 */
import { prisma } from '../src/prisma';
import { extractText } from '../src/drive/extract';
import { driveClient } from '../src/drive/client';
import { config } from '../src/config';

async function main(): Promise<void> {
  const fileId = process.argv[2];
  if (!fileId) throw new Error('pass a Drive file id');

  const preset = await prisma.promptPreset.findUniqueOrThrow({
    where: { key: 'drive.file_extraction.v1' },
    select: { template: true },
  });

  const drive = await driveClient();
  const meta = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,modifiedTime,size',
    supportsAllDrives: true,
  });
  const file = {
    id: fileId,
    name: meta.data.name ?? '?',
    mimeType: meta.data.mimeType ?? '?',
    parents: [],
    path: `(sample) / ${meta.data.name}`,
    modifiedTime: meta.data.modifiedTime ?? null,
    modifiedByEmail: null,
    createdTime: null,
    size: meta.data.size ? Number(meta.data.size) : null,
    isFolder: false,
  };
  const extraction = await extractText(file);
  if (extraction.kind !== 'ok') throw new Error(`extract failed: ${extraction.reason}`);

  const max = config.GEMINI_MAX_INPUT_CHARS;
  const fileText =
    extraction.text.length > max
      ? `${extraction.text.slice(0, max)}\n…\n[TRUNCATED]`
      : extraction.text;

  const vars: Record<string, string> = {
    account_name: 'Chevy',
    campaign_name: '02. Chevy | BHAC [GMCHV55000216]',
    known_campaigns_json: JSON.stringify(['02. Chevy | BHAC [GMCHV55000216]'], null, 2),
    file_path: file.path,
    modified_time: file.modifiedTime ?? '(unknown)',
    modified_by: '(unknown)',
    file_text: fileText,
  };
  let prompt = preset.template;
  for (const [k, v] of Object.entries(vars)) {
    prompt = prompt.replaceAll(`{{${k}}}`, v);
  }

  console.log(`FILE: ${file.name}  [${extraction.extractor}]`);
  console.log(`extracted text: ${extraction.text.length} chars`);
  console.log(`template:       ${preset.template.length} chars`);
  console.log(`FULL PROMPT:    ${prompt.length} chars  (≈${Math.round(prompt.length / 4)} tokens)`);
  console.log('─'.repeat(70));
  console.log(prompt.slice(0, 3000));
  console.log('… [middle omitted] …');
  const tail = prompt.indexOf('An EXECUTION') > 0 ? '' : prompt.slice(-1200);
  console.log(tail);
}

main()
  .then(async () => { await prisma.$disconnect(); process.exit(0); })
  .catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
