/**
 * seed-status-proposal.ts — write one additional_update row against a
 * chosen campaign or account, then print the reviewer magic link.
 *
 * This is the debug surface for iterating the status_synthesis prompt
 * (Phase 8 of docs/status-markdown-plan.md). The flow is:
 *
 *   1. Tweak the prompt source.
 *   2. Run this script to seed a real proposal.
 *   3. Click the printed magic link → exercise the actual review UI.
 *   4. Approve / reject / edit items in the UI.
 *   5. Watch GUB apply the decisions + run synthesis + write the new
 *      status_markdown to the DB.
 *   6. Inspect the resulting status_markdown (or campaign_changes /
 *      account_changes row).
 *
 * Deliberately uses the SAME approval flow as production — no synthesis
 * preview, no special-cased path. The whole point is to make iteration
 * feel like normal reviewer use.
 *
 * Usage:
 *   npm run seed:status -- --campaign-id <uuid> --reviewer-staff-id <uuid> \
 *     --items '[{"text":"Dan is now point of contact","source_file_ids":["abc"]}]'
 *
 *   npm run seed:status -- --account-id <uuid> --reviewer-staff-id <uuid> \
 *     --items-file ./items.json
 *
 *   npm run seed:status -- --campaign-id <uuid> --reviewer-staff-id <uuid> \
 *     --items '[{"text":"Launch shifted to June 1","source_file_ids":[]}]' \
 *     --also-field-changes '[{"field":"status","proposed_value":"live"}]'
 *
 * Flags:
 *   --campaign-id <uuid>          OR --account-id <uuid> (exactly one)
 *   --reviewer-staff-id <uuid>    Required. The staff member whose magic
 *                                 link the script will print.
 *   --items '<json>'              JSON array of {text, source_file_ids?}.
 *   --items-file <path>           Same shape, from a file.
 *   --also-field-changes '<json>' Optional. JSON array of
 *                                 {field, proposed_value} entries to
 *                                 also seed as field_change proposals in
 *                                 the same batch. Lets the reviewer
 *                                 exercise the full multi-card session.
 *   --base-url <url>              Override for the magic-link host.
 *                                 Defaults to env GUB_REVIEW_BASE_URL or
 *                                 GUB_ADMIN_BASE_URL.
 *   --ttl-days <n>                Override DRIVE_PROPOSAL_TTL_DAYS.
 *                                 Default 14.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/prisma';
import { config } from '../src/config';

interface Args {
  campaignId?: string;
  accountId?: string;
  reviewerStaffId: string;
  items: Array<{ text: string; source_file_ids: string[] }>;
  fieldChanges: Array<{ field: string; proposed_value: string | null }>;
  baseUrl: string;
  ttlDays: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const campaignId = get('--campaign-id');
  const accountId = get('--account-id');
  if ((campaignId && accountId) || (!campaignId && !accountId)) {
    throw new Error('Pass exactly one of --campaign-id or --account-id');
  }
  const reviewerStaffId = get('--reviewer-staff-id');
  if (!reviewerStaffId) {
    throw new Error('--reviewer-staff-id is required');
  }

  // Items can come from JSON inline or a file.
  let itemsRaw = get('--items');
  const itemsFile = get('--items-file');
  if (!itemsRaw && itemsFile) itemsRaw = readFileSync(itemsFile, 'utf-8');
  if (!itemsRaw) {
    throw new Error('Pass --items <json> or --items-file <path>');
  }
  const parsedItems = JSON.parse(itemsRaw) as unknown;
  if (!Array.isArray(parsedItems)) throw new Error('--items must be a JSON array');
  const items = parsedItems.map((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`items[${i}] must be an object`);
    }
    const r = raw as { text?: unknown; source_file_ids?: unknown };
    if (typeof r.text !== 'string') {
      throw new Error(`items[${i}].text must be a string`);
    }
    const sourceIds = Array.isArray(r.source_file_ids)
      ? (r.source_file_ids as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    return { text: r.text, source_file_ids: sourceIds };
  });

  const fcRaw = get('--also-field-changes');
  let fieldChanges: Args['fieldChanges'] = [];
  if (fcRaw) {
    const parsed = JSON.parse(fcRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('--also-field-changes must be a JSON array');
    fieldChanges = parsed.map((raw, i) => {
      if (!raw || typeof raw !== 'object') {
        throw new Error(`fieldChanges[${i}] must be an object`);
      }
      const r = raw as { field?: unknown; proposed_value?: unknown };
      if (typeof r.field !== 'string') {
        throw new Error(`fieldChanges[${i}].field must be a string`);
      }
      const pv = r.proposed_value;
      const proposedValue =
        pv === null || pv === undefined
          ? null
          : typeof pv === 'string' || typeof pv === 'number' || typeof pv === 'boolean'
            ? String(pv)
            : null;
      return { field: r.field, proposed_value: proposedValue };
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
    reviewerStaffId,
    items,
    fieldChanges,
    baseUrl,
    ttlDays,
  };
  if (campaignId) out.campaignId = campaignId;
  if (accountId) out.accountId = accountId;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entityType: 'account' | 'campaign' = args.accountId ? 'account' : 'campaign';
  const entityId = (args.accountId ?? args.campaignId)!;

  // Confirm the entity + reviewer exist before writing anything.
  if (entityType === 'account') {
    const a = await prisma.account.findUnique({ where: { id: entityId } });
    if (!a) throw new Error(`No account with id ${entityId}`);
    console.log(`Seeding against account: ${a.name} (${entityId})`);
  } else {
    const c = await prisma.campaign.findUnique({
      where: { id: entityId },
      include: { account: { select: { name: true } } },
    });
    if (!c) throw new Error(`No campaign with id ${entityId}`);
    console.log(`Seeding against campaign: ${c.name} (${entityId}) under ${c.account.name}`);
  }

  const reviewer = await prisma.staff.findUnique({ where: { id: args.reviewerStaffId } });
  if (!reviewer) throw new Error(`No staff with id ${args.reviewerStaffId}`);
  if (reviewer.status !== 'active') {
    throw new Error(`Reviewer ${reviewer.email} is not active (status=${reviewer.status})`);
  }
  console.log(`Reviewer: ${reviewer.fullName} <${reviewer.email}>`);

  const expiresAt = new Date(Date.now() + args.ttlDays * 24 * 60 * 60 * 1000);
  const unionSources = Array.from(
    new Set(args.items.flatMap((it) => it.source_file_ids)),
  );

  // Write the additional_update row.
  const updateRow = await prisma.driveChangeProposal.create({
    data: {
      kind: 'additional_update',
      property: '__note__',
      entityType,
      accountId: entityType === 'account' ? entityId : null,
      campaignId: entityType === 'campaign' ? entityId : null,
      currentValue: Prisma.JsonNull,
      proposedValue: { items: args.items } as unknown as Prisma.InputJsonValue,
      sourceFileIds: unionSources,
      state: 'pending',
      reviewToken: crypto.randomBytes(32).toString('hex'),
      reviewerEmail: reviewer.email,
      reviewerStaffId: reviewer.id,
      expiresAt,
    },
  });
  console.log(`Wrote additional_update row: ${updateRow.id} (${args.items.length} items)`);

  // Optionally seed field_change proposals too, so the reviewer can
  // exercise a mixed session.
  for (const fc of args.fieldChanges) {
    const fcRow = await prisma.driveChangeProposal.create({
      data: {
        kind: 'field_change',
        property: fc.field,
        entityType,
        accountId: entityType === 'account' ? entityId : null,
        campaignId: entityType === 'campaign' ? entityId : null,
        currentValue: Prisma.JsonNull,
        proposedValue: fc.proposed_value === null
          ? Prisma.JsonNull
          : (fc.proposed_value as Prisma.InputJsonValue),
        sourceFileIds: [],
        state: 'pending',
        reviewToken: crypto.randomBytes(32).toString('hex'),
        reviewerEmail: reviewer.email,
        reviewerStaffId: reviewer.id,
        expiresAt,
      },
    });
    console.log(`Wrote field_change row: ${fcRow.id} (${fc.field}=${fc.proposed_value})`);
  }

  const base = args.baseUrl.replace(/\/$/, '');
  const link = `${base}/drive-review/${updateRow.reviewToken}`;
  console.log('');
  console.log('Magic link (entry token = the additional_update row):');
  console.log(`  ${link}`);
  console.log('');
  console.log(
    `Open this URL to enter the reviewer flow. The session will surface all`,
  );
  console.log(`pending proposals for ${reviewer.fullName} on ${entityType} ${entityId}.`);
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
