/**
 * insight-asof.ts — D6 (#42): point-in-time insight queries.
 *
 * `insightsAsOf(entityType, entityId, at)` reconstructs the ACTIVE insight
 * set for an entity as of any past instant by replaying its append-only
 * `insight_changes` op-log up to the cutoff — the "current state = fold of
 * the change rows" pattern of the `*_changes` family (idea_changes et al.),
 * generalized from D4's now-invariant `replay(insight_changes) ==
 * snapshot(insights)` to an arbitrary `at`.
 *
 * Grounded in what the writers actually persist (GUB drive.review.ts apply,
 * D5 seed):
 *   - ADD    → change row's insight_id IS the new insight; new_text = text.
 *   - UPDATE → insight_id is the edited insight; new_text = its new text.
 *   - SUPERSEDE → ONE change row: insight_id = the dropped target, new_text
 *     = the replacement's text. There is no paired ADD row — the replacement
 *     insights row is minted in the same transaction and linked back via
 *     insights.created_by_op = change.id. The loader recovers the
 *     replacement id through that link, so a single fold step drops the
 *     target AND adds the replacement atomically (the active set is never
 *     transiently empty at any cutoff).
 *   - NOOP   → no state change (not written today — propose.ts filters
 *     NOOPs before they become cards — but the fold tolerates them).
 *
 * Ordering: strictly by created_at (timestamptz, tz-aware cutoff), ties
 * broken by id — ids are uuidv7 on every write path, so the tie-break is
 * itself time-ordered and deterministic across replays.
 *
 * Store access is prisma.$queryRaw like the rest of the insight tier (D3
 * precedent): drive-sync's Prisma schema has no Insight models until the
 * schema-package adoption lands. Read-only — this module never writes.
 */

import { prisma } from '../prisma';
import { logger } from '../logger';
import type { RetrievalScope } from './insight-reconcile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One op-log row, as the fold consumes it (already scoped + ordered). */
export interface InsightChangeRow {
  /** insight_changes.id — for warnings and the SUPERSEDE replacement link. */
  changeId: string;
  /** The insight the op targets (for SUPERSEDE: the DROPPED insight). */
  insightId: string;
  /** 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP' — string to tolerate unknowns. */
  op: string;
  /** Text after the op; for SUPERSEDE this is the REPLACEMENT's text. */
  newText: string | null;
  createdAt: Date;
  /** SUPERSEDE only: the replacement insight minted in the op's transaction
   * (insights.created_by_op = this change's id); null when the link is
   * missing (corrupt/foreign data — the fold warns and still drops). */
  replacementId: string | null;
}

/** An insight active at the requested cutoff. */
export interface AsOfInsight {
  id: string;
  text: string;
  /** created_at of the last op-log row that touched this insight ≤ cutoff. */
  lastChangeAt: Date;
}

/**
 * The entity's op-log rows with created_at <= at, oldest first, ties broken
 * by id. Scope is resolved by joining through insights (the change rows
 * carry no entity columns); a SUPERSEDE's replacement — created in the same
 * entity by the apply transaction — is reached via its own later rows'
 * insight_id, so the join covers the whole per-entity history.
 */
export async function loadInsightChanges(
  scope: RetrievalScope,
  at: Date,
): Promise<InsightChangeRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      change_id: string;
      insight_id: string;
      op: string;
      new_text: string | null;
      created_at: Date;
      replacement_id: string | null;
    }>
  >`
    SELECT ic.id::text         AS change_id,
           ic.insight_id::text AS insight_id,
           ic.op,
           ic.new_text,
           ic.created_at,
           repl.id::text       AS replacement_id
    FROM insight_changes ic
    JOIN insights i ON i.id = ic.insight_id
    LEFT JOIN insights repl
      ON ic.op = 'SUPERSEDE'
     AND repl.created_by_op = ic.id
     AND repl.id <> ic.insight_id
    WHERE i.entity_type = ${scope.entityType}
      AND i.entity_id = ${scope.entityId}::uuid
      AND ic.created_at <= ${at}
    ORDER BY ic.created_at ASC, ic.id ASC
  `;
  return rows.map((r) => ({
    changeId: r.change_id,
    insightId: r.insight_id,
    op: r.op,
    newText: r.new_text,
    createdAt: r.created_at,
    replacementId: r.replacement_id,
  }));
}

/**
 * The entity's CURRENT active snapshot rows — the right-hand side of the
 * D4 invariant `insightsAsOf(e, now) == snapshot`. For eval/verification
 * (and D7's read path); the replay itself never consults it.
 */
export async function snapshotActiveInsights(scope: RetrievalScope): Promise<AsOfInsight[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; text: string; updated_at: Date }>>`
    SELECT id::text AS id, text, updated_at
    FROM insights
    WHERE entity_type = ${scope.entityType}
      AND entity_id = ${scope.entityId}::uuid
      AND state = 'active'
    ORDER BY id ASC
  `;
  return rows.map((r) => ({ id: r.id, text: r.text, lastChangeAt: r.updated_at }));
}

export interface ReplayOptions {
  warn?: (message: string) => void;
}

/**
 * Pure fold over an ordered, pre-filtered op-log slice. Exported for the
 * hermetic suite; insightsAsOf is the loader-wired entry point.
 *
 * Malformed rows degrade softly with a warn — the log is append-only and a
 * historical query must not throw on one bad row years later:
 *   - UPDATE on an insight not in the active set upserts it (its ADD row is
 *     missing/foreign; the text is better preserved than dropped).
 *   - ADD/UPDATE without new_text is skipped (nothing to materialize).
 *   - SUPERSEDE always drops its target; the replacement is added only when
 *     both the created_by_op link and new_text exist.
 */
export function replayInsightChanges(
  rows: InsightChangeRow[],
  opts: ReplayOptions = {},
): AsOfInsight[] {
  const warn = opts.warn ?? ((m: string): void => logger.warn(`[insight-asof] ${m}`));
  const active = new Map<string, AsOfInsight>();

  for (const row of rows) {
    switch (row.op) {
      case 'ADD': {
        if (row.newText === null) {
          warn(`ADD ${row.changeId} carries no new_text — skipping`);
          break;
        }
        if (active.has(row.insightId)) {
          warn(`ADD ${row.changeId} re-adds active insight ${row.insightId} — replacing text`);
        }
        active.set(row.insightId, {
          id: row.insightId,
          text: row.newText,
          lastChangeAt: row.createdAt,
        });
        break;
      }
      case 'UPDATE': {
        if (row.newText === null) {
          warn(`UPDATE ${row.changeId} carries no new_text — skipping`);
          break;
        }
        if (!active.has(row.insightId)) {
          warn(
            `UPDATE ${row.changeId} targets insight ${row.insightId} not in the replayed active set — upserting`,
          );
        }
        active.set(row.insightId, {
          id: row.insightId,
          text: row.newText,
          lastChangeAt: row.createdAt,
        });
        break;
      }
      case 'SUPERSEDE': {
        // One row = drop target + add replacement, a single fold step — the
        // apply writes both in one transaction, so no cutoff can observe the
        // drop without the replacement.
        if (!active.delete(row.insightId)) {
          warn(
            `SUPERSEDE ${row.changeId} targets insight ${row.insightId} not in the replayed active set`,
          );
        }
        if (row.replacementId === null) {
          warn(
            `SUPERSEDE ${row.changeId} has no replacement insight (created_by_op link missing) — target dropped without replacement`,
          );
          break;
        }
        if (row.newText === null) {
          warn(`SUPERSEDE ${row.changeId} carries no new_text — replacement skipped`);
          break;
        }
        active.set(row.replacementId, {
          id: row.replacementId,
          text: row.newText,
          lastChangeAt: row.createdAt,
        });
        break;
      }
      case 'NOOP':
        break;
      default:
        warn(`unknown op "${row.op}" on change ${row.changeId} — ignoring`);
    }
  }

  // uuidv7 ids: lexicographic == chronological, so this reads oldest-first.
  return [...active.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Injectable seam so the hermetic suite never touches prisma (D3 precedent). */
export interface AsOfOptions extends ReplayOptions {
  loadChanges?: typeof loadInsightChanges;
}

/**
 * The entity's active insight set as of `at` (inclusive, tz-aware — the
 * cutoff compares against timestamptz in UTC). `insightsAsOf(e, now)`
 * equals the current active snapshot for the entity (the D4 invariant).
 */
export async function insightsAsOf(
  entityType: RetrievalScope['entityType'],
  entityId: string,
  at: Date,
  opts: AsOfOptions = {},
): Promise<AsOfInsight[]> {
  if (Number.isNaN(at.getTime())) {
    throw new Error('insightsAsOf: `at` is an invalid Date');
  }
  if (!UUID_RE.test(entityId)) {
    throw new Error(`insightsAsOf: entityId "${entityId}" is not a uuid`);
  }
  const load = opts.loadChanges ?? loadInsightChanges;
  const rows = await load({ entityType, entityId }, at);
  return replayInsightChanges(rows, opts);
}
