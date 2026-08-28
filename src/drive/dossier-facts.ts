// D5 (#41): split a stored status_markdown dossier into the discrete facts
// the insight-store seed backfills from. Pure text processing over the
// dossier monolith (the shape status-synthesis.ts assembles): the
// `## Context` body plus the surviving `## Transient` bullets, for each of
// the general/sensitive column pair. `## At a glance` is deliberately NOT
// parsed — it's a code render of structured entity fields (D11), so seeding
// it would duplicate row data as prose insights.
//
// NO prisma, NO ai imports — orchestration (store diff, reconcile, apply)
// lives in scripts/seed-insights.ts; this module stays hermetically
// testable, per the D2 candidate-insight precedent.

import type { DistilledNote } from './candidate-insight';
import {
  extractContextSection,
  extractTransientSection,
  pruneExpiredTransientBullets,
} from './status-synthesis';

/**
 * Floor for a parsed line to count as a fact — drops stray bullet markers,
 * lone punctuation, and blank-ish debris without judging real content.
 */
export const MIN_FACT_LENGTH = 3;

/** Dossier tier a seeded fact's provenance sentinel names. */
export type DossierTier = 'status_markdown' | 'status_sensitive_markdown';

/**
 * FALLBACK provenance for a bullet without a `[src: ...]` citation (old
 * prose-era dossiers). The dossier is a DB column, not a Drive file, so the
 * "source file id" is a stable non-Drive ref — the same pattern as the
 * scan's `piece:<id>` rollup source ids. Carrying the tier keeps
 * sensitive-sourced facts identifiable (the insight schema has no
 * sensitivity flag today; a later sensitivity backfill can key off this).
 */
export function dossierSourceId(
  tier: DossierTier,
  entityType: 'account' | 'campaign',
  entityId: string,
): string {
  return `${tier}:${entityType}:${entityId}`;
}

/**
 * Every synthesized bullet ends with a `[src: <fileId>]` citation (the
 * status-synthesis output contract; merged bullets can carry several).
 * That's the fact's REAL Drive provenance — hoist it into structured
 * sourceFileIds like every live candidate, and strip the marker from the
 * fact text so embeddings and reconciliation compare facts, not citation
 * tails. `[expires: ...]` markers are deliberately KEPT in the text — the
 * store has no expiry mechanics, so the shelf-life is part of the fact.
 */
const SRC_MARKER_RE = /\s*\[src:\s*([^\]]+)\]/g;

export function extractSrcMarkers(line: string): { text: string; fileIds: string[] } {
  const fileIds: string[] = [];
  const text = line
    .replace(SRC_MARKER_RE, (_match, ids: string) => {
      for (const id of ids.split(/[\s,]+/)) {
        if (id.length > 0 && !fileIds.includes(id)) fileIds.push(id);
      }
      return '';
    })
    .trim();
  return { text, fileIds };
}

/**
 * Section body → one fact per line. Context/Transient bodies are
 * code-assembled bullet text (one `- bullet` per line, per the synthesis
 * contract), but older dossiers may hold prose — a line-based split handles
 * both: the bullet marker is stripped when present, and any non-empty line
 * stands as one fact. Never seed the whole blob as one insight (pitfall 3).
 */
export function splitDossierBullets(body: string | null): string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s?/, '').trim())
    .filter((text) => text.length >= MIN_FACT_LENGTH);
}

export interface DossierFactsArgs {
  statusMarkdown: string | null;
  statusSensitiveMarkdown: string | null;
  /** Scan day (YYYY-MM-DD) — transient bullets expiring before it are dropped. */
  asOfDate: string;
  generalSourceId: string;
  sensitiveSourceId: string;
}

/**
 * Parse one entity's dossier pair into discrete seed facts, shaped as
 * DistilledNotes so toCandidateInsights consumes them unchanged.
 *
 * - Expired transient bullets are dropped BEFORE splitting (D23 posture:
 *   the seed never resurrects what synthesis would prune).
 * - `[src: ...]` citations become the note's source_file_ids; a bullet
 *   without one falls back to the tier's dossier sentinel, so provenance
 *   is never empty (A1).
 * - Facts are deduped by exact (post-strip) text across sections AND
 *   tiers — two identical candidates in one run would otherwise both
 *   reconcile against a store that contains neither, and both would ADD.
 *   First occurrence wins, so a fact present in both tiers keeps the
 *   general provenance.
 */
export function dossierFacts(args: DossierFactsArgs): DistilledNote[] {
  const facts: DistilledNote[] = [];
  const seen = new Set<string>();

  const collect = (stored: string | null, fallbackSourceId: string): void => {
    if (!stored) return;
    const context = extractContextSection(stored);
    const transient = pruneExpiredTransientBullets(extractTransientSection(stored), args.asOfDate);
    for (const line of [...splitDossierBullets(context), ...splitDossierBullets(transient)]) {
      const { text, fileIds } = extractSrcMarkers(line);
      if (text.length < MIN_FACT_LENGTH || seen.has(text)) continue;
      seen.add(text);
      facts.push({
        text,
        source_file_ids: fileIds.length > 0 ? fileIds : [fallbackSourceId],
      });
    }
  };

  collect(args.statusMarkdown, args.generalSourceId);
  collect(args.statusSensitiveMarkdown, args.sensitiveSourceId);
  return facts;
}
