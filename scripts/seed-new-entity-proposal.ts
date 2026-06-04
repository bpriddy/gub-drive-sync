/**
 * seed-new-entity-proposal.ts — write one new_entity proposal group (with
 * optional attached observations) and print the reviewer magic link.
 *
 * This is the Phase 7 sibling to seed-status-proposal.ts. The flow:
 *
 *   1. Tweak prompt source (new_entity_extraction, status_synthesis,
 *      file_extraction — whichever you're iterating).
 *   2. Run this script to seed a fake new-entity proposal with realistic
 *      attached observations.
 *   3. Click the printed magic link → exercise the actual review UI.
 *   4. Edit observations / field overrides / approve.
 *   5. Watch GUB apply the decisions: entity is created, attached
 *      additional_update is flipped + retargeted to the new entity, and
 *      post-approval synthesis writes the v1 status_markdown (with
 *      edited_at header + code-rendered bullets + LLM-written Context).
 *   6. Inspect the new entity's status_markdown column.
 *
 * Like seed-status-proposal.ts, this uses the SAME approval flow as
 * production. No special preview paths.
 *
 * Usage:
 *   # Seed a new campaign under an existing account, with two observations:
 *   npm run seed:new-entity -- \
 *     --entity-type campaign \
 *     --name "Diageo Spring Pitch" \
 *     --parent-account-id <uuid> \
 *     --source-drive-folder-id <drive-folder-id> \
 *     --reviewer-staff-id <uuid> \
 *     --fields '{"status":"pitch","budget":"250000"}' \
 *     --observations '[{"text":"Brief landed 2026-05-20; brand-voice work","source_file_ids":["1abc"]},{"text":"Team includes Maya as creative lead","source_file_ids":["1abc"]}]'
 *
 *   # Seed a brand-new account at the root, with observations from a file:
 *   npm run seed:new-entity -- \
 *     --entity-type account \
 *     --name "Acme Corp" \
 *     --source-drive-folder-id <drive-folder-id> \
 *     --reviewer-staff-id <uuid> \
 *     --observations-file ./obs.json
 *
 * Flags:
 *   --entity-type account|campaign      Required.
 *   --name <string>                     Required. Proposed entity name.
 *   --parent-account-id <uuid>          Required when entity-type=campaign.
 *   --source-drive-folder-id <id>       Required. Folder id that will be
 *                                       stored on the created entity as
 *                                       drive_folder_id.
 *   --reviewer-staff-id <uuid>          Required.
 *   --fields '<json>'                   Optional. Map of writable field key →
 *                                       proposed value string. One new_entity
 *                                       row per entry, in addition to `name`.
 *   --observations '<json>'             Optional. Array of {text,
 *                                       source_file_ids?}. Written as ONE
 *                                       additional_update row sharing the
 *                                       new-entity group id.
 *   --observations-file <path>          Same shape from a file.
 *   --base-url <url>                    Override magic-link host. Defaults
 *                                       to env GUB_REVIEW_BASE_URL or
 *                                       GUB_ADMIN_BASE_URL.
 *   --ttl-days <n>                      Override DRIVE_PROPOSAL_TTL_DAYS.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { config } from '../src/config';

interface Args {
  entityType: 'account' | 'campaign';
  name: string;
  parentAccountId?: string;
  sourceDriveFolderId: string;
  reviewerStaffId: string;
  fields: Record<string, string>;
  observations: Array<{ text: string; source_file_ids: string[] }>;
  baseUrl: string;
  ttlDays: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const entityTypeRaw = get('--entity-type');
  if (entityTypeRaw !== 'account' && entityTypeRaw !== 'campaign') {
    throw new Error('--entity-type must be `account` or `campaign`');
  }
  const entityType = entityTypeRaw;

  const name = get('--name');
  if (!name || !name.trim()) {
    throw new Error('--name is required (non-empty)');
  }

  const parentAccountId = get('--parent-account-id');
  if (entityType === 'campaign' && !parentAccountId) {
    throw new Error('--parent-account-id is required when --entity-type=campaign');
  }
  if (entityType === 'account' && parentAccountId) {
    throw new Error('--parent-account-id is invalid when --entity-type=account');
  }

  const sourceDriveFolderId = get('--source-drive-folder-id');
  if (!sourceDriveFolderId) {
    throw new Error('--source-drive-folder-id is required');
  }

  const reviewerStaffId = get('--reviewer-staff-id');
  if (!reviewerStaffId) {
    throw new Error('--reviewer-staff-id is required');
  }

  // --fields '<json>' → Record<string, string>. Optional.
  const fieldsRaw = get('--fields');
  let fields: Record<string, string> = {};
  if (fieldsRaw) {
    const parsed = JSON.parse(fieldsRaw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('--fields must be a JSON object');
    }
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new Error(`--fields.${k} must be string|number|boolean|null`);
      }
      fields[k] = String(v);
    }
  }

  // --observations '<json>' OR --observations-file → Array<{text, source_file_ids?}>.
  let obsRaw = get('--observations');
  const obsFile = get('--observations-file');
  if (!obsRaw && obsFile) obsRaw = readFileSync(obsFile, 'utf-8');
  let observations: Args['observations'] = [];
  if (obsRaw) {
    const parsed = JSON.parse(obsRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('--observations must be a JSON array');
    observations = parsed.map((raw, i) => {
      if (!raw || typeof raw !== 'object') {
        throw new Error(`observations[${i}] must be an object`);
      }
      const r = raw as { text?: unknown; source_file_ids?: unknown };
      if (typeof r.text !== 'string') {
        throw new Error(`observations[${i}].text must be a string`);
      }
      const sourceIds = Array.isArray(r.source_file_ids)
        ? (r.source_file_ids as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      return { text: r.text, source_file_ids: sourceIds };
    });
  }

  const baseUrl =
    get('--base-url') ??
    process.env['GUB_REVIEW_BASE_URL'] ??
    process.env['GUB_ADMIN_BASE_URL'] ??
    'http://localhost:5173';

  const ttlDaysStr = get('--ttl-days');
  const ttlDays = ttlDaysStr ? Number(ttlDaysStr) : config.DRIVE_PROPOSAL_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('--ttl-days must be a positive integer');
  }

  const out: Args = {
    entityType,
    name: name.trim(),
    sourceDriveFolderId,
    reviewerStaffId,
    fields,
    observations,
    baseUrl,
    ttlDays,
  };
  if (parentAccountId) out.parentAccountId = parentAccountId;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Validate the reviewer is real + active before writing anything.
  const reviewer = await prisma.staff.findUnique({ where: { id: args.reviewerStaffId } });
  if (!reviewer) throw new Error(`No staff with id ${args.reviewerStaffId}`);
  if (reviewer.status !== 'active') {
    throw new Error(`Reviewer ${reviewer.email} is not active (status=${reviewer.status})`);
  }
  console.log(`Reviewer: ${reviewer.fullName} <${reviewer.email}>`);

  // For campaign entity-type, confirm the parent account exists.
  if (args.entityType === 'campaign') {
    const parent = await prisma.account.findUnique({
      where: { id: args.parentAccountId! },
      select: { id: true, name: true },
    });
    if (!parent) throw new Error(`No account with id ${args.parentAccountId}`);
    console.log(`Parent account: ${parent.name} (${parent.id})`);
  }

  console.log(
    `Seeding new-${args.entityType} proposal: name="${args.name}", ` +
      `fields=${Object.keys(args.fields).length}, observations=${args.observations.length}`,
  );

  const groupId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + args.ttlDays * 24 * 60 * 60 * 1000);

  // Build the new_entity rows: one for `name` + one per fields entry.
  type ProposalRow = { property: string; proposedValue: Prisma.InputJsonValue };
  const newEntityRows: ProposalRow[] = [{ property: 'name', proposedValue: args.name }];
  for (const [k, v] of Object.entries(args.fields)) {
    newEntityRows.push({ property: k, proposedValue: v });
  }

  // Optional attached additional_update row carrying the observations.
  const unionSources = Array.from(
    new Set(args.observations.flatMap((it) => it.source_file_ids)),
  );

  // Write all rows under one proposal_group_id, atomically.
  const result = await prisma.$transaction([
    ...newEntityRows.map((row) =>
      prisma.driveChangeProposal.create({
        data: {
          kind: 'new_entity',
          proposalGroupId: groupId,
          sourceDriveFolderId: args.sourceDriveFolderId,
          syncRunId: null,
          entityType: args.entityType,
          accountId: args.entityType === 'campaign' ? args.parentAccountId! : null,
          campaignId: null,
          property: row.property,
          currentValue: Prisma.JsonNull,
          proposedValue: row.proposedValue,
          reasoning: 'Seeded by scripts/seed-new-entity-proposal.ts',
          sourceFileIds: unionSources,
          confidence: new Prisma.Decimal(0.9),
          state: 'pending',
          reviewToken: crypto.randomBytes(32).toString('hex'),
          reviewerEmail: reviewer.email,
          reviewerStaffId: reviewer.id,
          expiresAt,
        },
      }),
    ),
    ...(args.observations.length > 0
      ? [
          prisma.driveChangeProposal.create({
            data: {
              kind: 'additional_update',
              proposalGroupId: groupId,
              sourceDriveFolderId: args.sourceDriveFolderId,
              syncRunId: null,
              entityType: args.entityType,
              accountId: args.entityType === 'campaign' ? args.parentAccountId! : null,
              campaignId: null,
              property: '__note__',
              currentValue: Prisma.JsonNull,
              proposedValue: { items: args.observations } as Prisma.InputJsonValue,
              reasoning: null,
              sourceFileIds: unionSources,
              confidence: null,
              state: 'pending',
              reviewToken: crypto.randomBytes(32).toString('hex'),
              reviewerEmail: reviewer.email,
              reviewerStaffId: reviewer.id,
              expiresAt,
            },
          }),
        ]
      : []),
  ]);

  // Use the first new_entity row's token as the magic-link entry. Any row
  // in the reviewer's pending set would work — the session resolver loads
  // ALL pending proposals for the reviewer. Using a deterministic row
  // (the first new_entity) makes the printed link stable for re-runs.
  const entryToken = result[0]!.reviewToken;
  const base = args.baseUrl.replace(/\/$/, '');
  const link = `${base}/drive-review/${entryToken}`;

  console.log('');
  console.log(`Group id:  ${groupId}`);
  console.log(`Wrote ${newEntityRows.length} new_entity row(s)` +
    (args.observations.length > 0
      ? ` + 1 attached additional_update (${args.observations.length} items).`
      : ' (no attached observations).'),
  );
  console.log('');
  console.log('Magic link (entry token = first new_entity row):');
  console.log(`  ${link}`);
  console.log('');
  console.log(
    `Open this URL to enter the reviewer flow. The session will surface ALL`,
  );
  console.log(`pending proposals for ${reviewer.fullName}, including this group.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
