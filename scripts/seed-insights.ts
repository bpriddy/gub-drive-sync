/**
 * seed-insights.ts — D5 (#41): one-shot, idempotent backfill of the insight
 * store from each entity's status_markdown dossier.
 *
 * Per entity: parse the stored dossier pair (## Context + surviving
 * ## Transient bullets, general + sensitive tiers) into discrete facts →
 * shape as D2 candidates → reconcile against the store container → apply
 * the resulting ADD ops DIRECTLY to insights + insight_changes. Each
 * bullet's `[src: ...]` citation is hoisted into the candidate's
 * sourceFileIds (real Drive provenance, stripped from the fact text);
 * markerless bullets fall back to a `status_markdown:<type>:<id>` dossier
 * sentinel so provenance is never empty (A1).
 *
 * Direct write, NOT the review gate: a whole-dossier backfill would flood
 * the reviewer with hundreds of insight_op cards — the B1 gate is for live
 * deltas, not the one-time bootstrap. The audit row is still written —
 * insight_changes(op:'ADD', created_by = DRIVE_SYNC_SYSTEM_STAFF_ID) — so
 * the D6 invariant replay(insight_changes) == snapshot(insights) holds over
 * seeded rows. Seed rows carry sync_run_id = NULL and op_hash = NULL (no
 * run, no proposal card; the UNIQUE (sync_run_id, op_hash) key treats NULLs
 * as distinct — see InsightChange in gub-schemas).
 *
 * Idempotency is deterministic, not LLM-dependent: before reconciling, any
 * candidate whose exact text already exists as an ACTIVE insight in its
 * container is dropped as a NOOP. A re-run over an unchanged dossier
 * re-derives identical texts → all NOOP → zero new rows, zero Gemini calls.
 * Only near-duplicates (a store that drifted via live scans) reach
 * embed → retrieve → LLM reconcile — which needs the
 * drive.insight_reconcile.v1 preset — and of those ops ONLY ADDs are
 * applied: the seed never mutates existing insights (UPDATE/SUPERSEDE/NOOP
 * are logged and skipped; live reconciliation owns merges).
 *
 * Usage:
 *   npm run seed:insights -- --all [--dry-run]
 *   npm run seed:insights -- --account-id <uuid> [--dry-run]
 *   npm run seed:insights -- --campaign-id <uuid> [--dry-run]
 *
 * Flags:
 *   --account-id <uuid>   Seed this account's container AND all its
 *                         campaigns' containers (the per-account unit the
 *                         backfill is grouped/logged by).
 *   --campaign-id <uuid>  Seed one campaign container.
 *   --all                 Every account + campaign with a stored dossier.
 *   --dry-run             Parse + validate + diff against the store; print
 *                         each candidate as would-seed / already-present.
 *                         No writes, no Gemini calls (reconcile is skipped,
 *                         so near-duplicates print as would-seed even when
 *                         a real run would merge-skip them).
 *   --as-of <YYYY-MM-DD>  Transient-expiry cutoff (default: today).
 *
 * Pieces (campaign_pieces.status_markdown) are deliberately out of scope —
 * piece/idea insights are the separate idea-extraction tier (D2 ruling),
 * and the candidate contract is account|campaign only.
 */
import crypto from 'node:crypto';
import { prisma } from '../src/prisma';
import { embedTexts } from '../src/ai';
import {
  toCandidateInsights,
  type CandidateInsight,
  type CandidateTarget,
} from '../src/drive/candidate-insight';
import { dossierFacts, dossierSourceId } from '../src/drive/dossier-facts';
import { DRIVE_SYNC_SYSTEM_STAFF_ID } from '../src/drive/heal';
import { reconcileCandidates, type InsightOp } from '../src/drive/insight-reconcile';

interface Args {
  accountId?: string;
  campaignId?: string;
  all: boolean;
  dryRun: boolean;
  asOfDate: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const accountId = get('--account-id');
  const campaignId = get('--campaign-id');
  const all = argv.includes('--all');
  const targets = [accountId, campaignId, all ? '--all' : undefined].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error('Pass exactly one of --account-id <uuid>, --campaign-id <uuid>, --all');
  }

  const asOfDate = get('--as-of') ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new Error('--as-of must be YYYY-MM-DD');
  }

  const out: Args = { all, dryRun: argv.includes('--dry-run'), asOfDate };
  if (accountId) out.accountId = accountId;
  if (campaignId) out.campaignId = campaignId;
  return out;
}

// ── Entity collection ────────────────────────────────────────────────────────

interface SeedEntity {
  accountId: string;
  accountName: string;
  entityType: 'account' | 'campaign';
  entityId: string;
  entityName: string;
  campaignFolderId: string | null;
  statusMarkdown: string | null;
  statusSensitiveMarkdown: string | null;
}

/** Only entities with a stored dossier — everything else has nothing to seed. */
const HAS_DOSSIER = {
  OR: [{ statusMarkdown: { not: null } }, { statusSensitiveMarkdown: { not: null } }],
};

// Explicit selects everywhere below: the seed only reads scope + dossier
// columns, and a narrow select keeps the script runnable against a prod
// copy that lags the freshest migrations.
const ACCOUNT_SELECT = {
  id: true,
  name: true,
  driveFolderId: true,
  statusMarkdown: true,
  statusSensitiveMarkdown: true,
} as const;

const CAMPAIGN_SELECT = {
  id: true,
  accountId: true,
  name: true,
  driveFolderId: true,
  statusMarkdown: true,
  statusSensitiveMarkdown: true,
  account: { select: { name: true } },
} as const;

async function collectEntities(args: Args): Promise<SeedEntity[]> {
  if (args.campaignId) {
    const c = await prisma.campaign.findUnique({
      where: { id: args.campaignId },
      select: CAMPAIGN_SELECT,
    });
    if (!c) throw new Error(`No campaign with id ${args.campaignId}`);
    return [
      {
        accountId: c.accountId,
        accountName: c.account.name,
        entityType: 'campaign',
        entityId: c.id,
        entityName: c.name,
        campaignFolderId: c.driveFolderId,
        statusMarkdown: c.statusMarkdown,
        statusSensitiveMarkdown: c.statusSensitiveMarkdown,
      },
    ];
  }

  const accounts = await prisma.account.findMany({
    where: args.accountId ? { id: args.accountId } : HAS_DOSSIER,
    select: ACCOUNT_SELECT,
    orderBy: { name: 'asc' },
  });
  if (args.accountId && accounts.length === 0) {
    throw new Error(`No account with id ${args.accountId}`);
  }
  const campaigns = await prisma.campaign.findMany({
    where: args.accountId ? { accountId: args.accountId, ...HAS_DOSSIER } : HAS_DOSSIER,
    select: CAMPAIGN_SELECT,
    orderBy: [{ accountId: 'asc' }, { name: 'asc' }],
  });

  return [
    ...accounts.map((a): SeedEntity => ({
      accountId: a.id,
      accountName: a.name,
      entityType: 'account',
      entityId: a.id,
      entityName: a.name,
      campaignFolderId: a.driveFolderId,
      statusMarkdown: a.statusMarkdown,
      statusSensitiveMarkdown: a.statusSensitiveMarkdown,
    })),
    ...campaigns.map((c): SeedEntity => ({
      accountId: c.accountId,
      accountName: c.account.name,
      entityType: 'campaign',
      entityId: c.id,
      entityName: c.name,
      campaignFolderId: c.driveFolderId,
      statusMarkdown: c.statusMarkdown,
      statusSensitiveMarkdown: c.statusSensitiveMarkdown,
    })),
  ];
}

// ── Store access ─────────────────────────────────────────────────────────────

/** Exact texts already ACTIVE in the container — the deterministic NOOP
 *  filter. Embedding-status-independent on purpose: a row that lost (or
 *  never got) its vector is invisible to D3 retrieval but still means "this
 *  fact is seeded". */
async function fetchActiveTexts(
  entityType: 'account' | 'campaign',
  entityId: string,
): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ text: string }>>`
    SELECT text FROM insights
    WHERE entity_type = ${entityType}
      AND entity_id = ${entityId}::uuid
      AND state = 'active'
  `;
  return new Set(rows.map((r) => r.text));
}

/**
 * UUIDv7 — the store's id convention (@default(uuid(7)) in gub-schemas,
 * generated client-side by Prisma, which raw SQL bypasses). Time-ordered
 * ids keep seeded rows consistent with apply-path rows.
 */
function uuidv7(): string {
  const bytes = crypto.randomBytes(16);
  const ts = BigInt(Date.now());
  for (let i = 0; i < 6; i++) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Apply ADD ops directly: insights row + insight_changes(ADD) audit row, one
 * transaction per entity. Raw SQL because drive-sync's Prisma schema has no
 * Insight models (D3 precedent) and `embedding` is Unsupported("vector")
 * anyway. The column list stays valid on both the dev Appendix-A DDL and
 * the canonical D1/D4 migrations: sync_run_id / op_hash are omitted (seed
 * rows carry NULL), created_at/updated_at are explicit (canonical
 * insights.updated_at has no DB default).
 *
 * Embedding failure aborts BEFORE any write — a seeded row without a vector
 * would be invisible to D3 retrieval, and the deterministic NOOP filter
 * makes a re-run after fixing credentials safe.
 */
async function applyAdds(adds: InsightOp[]): Promise<void> {
  if (adds.length === 0) return;
  const vectors = await embedTexts(adds.map((op) => op.candidate.text));
  await prisma.$transaction(
    async (tx) => {
      for (const [i, op] of adds.entries()) {
        const c: CandidateInsight = op.candidate;
        const insightId = uuidv7();
        const changeId = uuidv7();
        const vec = `[${vectors[i]!.join(',')}]`;
        // created_by_op is a plain uuid (no FK), so it can reference the
        // change row inserted after it — same link the apply path writes.
        await tx.$executeRaw`
          INSERT INTO insights
            (id, account_id, entity_type, entity_id, text, embedding, state,
             created_by_op, created_at, updated_at)
          VALUES
            (${insightId}::uuid, ${c.accountId}::uuid, ${c.entityType},
             ${c.entityId}::uuid, ${c.text}, ${vec}::vector, 'active',
             ${changeId}::uuid, now(), now())
        `;
        await tx.$executeRaw`
          INSERT INTO insight_changes
            (id, insight_id, op, previous_text, new_text, source_file_ids,
             confidence, created_by, created_at)
          VALUES
            (${changeId}::uuid, ${insightId}::uuid, 'ADD', NULL, ${c.text},
             ${c.sourceFileIds}::text[], ${c.confidence},
             ${DRIVE_SYNC_SYSTEM_STAFF_ID}::uuid, now())
        `;
      }
    },
    { timeout: 120_000 },
  );
}

// ── Per-entity flow ──────────────────────────────────────────────────────────

interface EntityCounts {
  facts: number;
  candidates: number;
  /** Real run: ADDs applied. Dry run: candidates that would be seeded. */
  seeded: number;
  /** Exact text already ACTIVE in the container. */
  noops: number;
  /** Reconcile emitted a merge verb / NOOP — not applied by the seed. */
  skipped: number;
}

async function processEntity(entity: SeedEntity, args: Args): Promise<EntityCounts> {
  const label = `${entity.entityType} "${entity.entityName}"`;
  const warn = (m: string): void => console.warn(`  ⚠ ${m}`);

  const facts = dossierFacts({
    statusMarkdown: entity.statusMarkdown,
    statusSensitiveMarkdown: entity.statusSensitiveMarkdown,
    asOfDate: args.asOfDate,
    generalSourceId: dossierSourceId('status_markdown', entity.entityType, entity.entityId),
    sensitiveSourceId: dossierSourceId(
      'status_sensitive_markdown',
      entity.entityType,
      entity.entityId,
    ),
  });

  const target: CandidateTarget = {
    accountId: entity.accountId,
    entityType: entity.entityType,
    entityStatus: entity.entityType === 'account' ? 'account' : 'existing',
    entityId: entity.entityId,
    campaignFolderId: entity.campaignFolderId,
    entityName: entity.entityName,
  };
  const candidates = toCandidateInsights(target, { field_changes: [], notes: facts }, warn);

  const existing = await fetchActiveTexts(entity.entityType, entity.entityId);
  const fresh = candidates.filter((c) => !existing.has(c.text));
  const noops = candidates.length - fresh.length;

  if (args.dryRun) {
    for (const c of candidates) {
      const status = existing.has(c.text) ? 'already-present' : 'would-seed';
      console.log(`  [${status}] ${c.text}  ← ${c.sourceFileIds.join(', ')}`);
    }
    console.log(
      `  ${label}: facts=${facts.length} candidates=${candidates.length} would-seed=${fresh.length} noop=${noops}`,
    );
    return {
      facts: facts.length,
      candidates: candidates.length,
      seeded: fresh.length,
      noops,
      skipped: 0,
    };
  }

  const ops = fresh.length > 0 ? await reconcileCandidates(fresh, { warn }) : [];
  const adds = ops.filter((op) => op.op === 'ADD');
  const skippedOps = ops.filter((op) => op.op !== 'ADD');
  for (const op of skippedOps) {
    console.log(
      `  [skip ${op.op}] "${op.candidate.text.slice(0, 80)}" — ${op.reasoning} (the seed never mutates existing insights)`,
    );
  }

  await applyAdds(adds);
  console.log(
    `  ${label}: facts=${facts.length} seeded=${adds.length} noop=${noops} skipped=${skippedOps.length}`,
  );
  return {
    facts: facts.length,
    candidates: candidates.length,
    seeded: adds.length,
    noops,
    skipped: skippedOps.length,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const entities = await collectEntities(args);
  if (entities.length === 0) {
    console.log('Nothing to seed — no entities with a stored dossier.');
    return;
  }

  console.log(
    `${args.dryRun ? 'DRY RUN (no writes) — ' : ''}seeding insight store from ${entities.length} dossier(s), transient cutoff ${args.asOfDate}`,
  );

  const byAccount = new Map<string, { name: string; counts: EntityCounts }>();
  const failures: string[] = [];

  for (const entity of entities) {
    console.log(
      `\n${entity.accountName} / ${entity.entityType} "${entity.entityName}" (${entity.entityId})`,
    );
    try {
      const counts = await processEntity(entity, args);
      const roll = byAccount.get(entity.accountId) ?? {
        name: entity.accountName,
        counts: { facts: 0, candidates: 0, seeded: 0, noops: 0, skipped: 0 },
      };
      roll.counts.facts += counts.facts;
      roll.counts.candidates += counts.candidates;
      roll.counts.seeded += counts.seeded;
      roll.counts.noops += counts.noops;
      roll.counts.skipped += counts.skipped;
      byAccount.set(entity.accountId, roll);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ failed: ${msg}`);
      failures.push(`${entity.entityType} ${entity.entityId} ("${entity.entityName}"): ${msg}`);
    }
  }

  console.log(`\nPer-account totals${args.dryRun ? ' (dry-run)' : ''}:`);
  for (const { name, counts } of byAccount.values()) {
    console.log(
      `  ${name}: ${counts.seeded} insight(s) ${args.dryRun ? 'would be ' : ''}seeded / ${counts.noops} already present / ${counts.skipped} skipped (merge-verb) — ${counts.candidates} candidates from ${counts.facts} facts`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} entity(ies) failed — re-run is safe (idempotent):\n  ${failures.join('\n  ')}`,
    );
  }
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
