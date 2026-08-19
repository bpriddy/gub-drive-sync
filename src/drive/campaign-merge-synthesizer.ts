/**
 * campaign-merge-synthesizer.ts — produces one unified status_markdown
 * + status_sensitive_markdown for the canonical Campaign row by merging
 * the markdown bullets across all variants in a merge cluster.
 *
 * Approach: reuse the production status-synthesis prompt. Feed every
 * variant's Context + Transient bullets as the "prior" inputs and pass
 * empty arrays for "new approved" — the synthesis prompt's DEDUPLICATE
 * rule then collapses repeated facts within each tier. Output is parsed
 * and re-assembled via the same helpers production uses, so the merged
 * blob is byte-faithful to what production synthesis would produce.
 *
 * Structured fields (status, budget, awarded_at, etc.) are NOT merged
 * here — the canonical row keeps its existing values. The at-a-glance
 * bullets are rendered from the canonical's CurrentState.
 *
 * Transient bullets get pre-pruned (any [expires:] before scanDay are
 * dropped before synthesis sees them), matching the production behavior.
 */

import { defaultLlm, DEFAULT_GEMINI_MODEL } from '../ai';
import { logger } from '../logger';
import type { CampaignCurrentState } from './schema';
import {
  assembleSensitiveStatusMarkdown,
  assembleStatusMarkdown,
  campaignFieldsAsMap,
  extractContextSection,
  extractTransientSection,
  parseQuadContextOutput,
  pruneExpiredTransientBullets,
  renderAtAGlanceBullets,
  renderStatusSynthesisV1Prompt,
  STATUS_SYNTHESIS_V1_VERSION,
} from './status-synthesis';

const MODEL = DEFAULT_GEMINI_MODEL;
const TEMPERATURE = 0.2;

export interface VariantMarkdown {
  /** Display name for logging only. */
  name: string;
  status: string | null;
  sensitive: string | null;
}

export interface MergedMarkdowns {
  status: string;
  sensitive: string | null;
  /** True when synthesis was skipped (all variants had empty/null prior bullets). */
  skippedSynthesis: boolean;
}

/**
 * Concatenate the same-section bullets across all variant markdowns.
 * Each variant contributes its already-bullet-listed body; we join with
 * newlines so the LLM sees one combined "prior" list per section.
 */
function concatSections(
  variants: VariantMarkdown[],
  pick: (md: string | null) => string | null,
): string | null {
  const sections: string[] = [];
  for (const v of variants) {
    const status = pick(v.status);
    if (status) sections.push(status);
  }
  if (sections.length === 0) return null;
  return sections.join('\n');
}

function concatSensitive(
  variants: VariantMarkdown[],
  pick: (md: string | null) => string | null,
): string | null {
  const sections: string[] = [];
  for (const v of variants) {
    const sensitive = pick(v.sensitive);
    if (sensitive) sections.push(sensitive);
  }
  if (sections.length === 0) return null;
  return sections.join('\n');
}

export async function mergeCampaignMarkdowns(args: {
  canonicalName: string;
  accountName: string;
  canonicalState: CampaignCurrentState;
  /** YYYY-MM-DD — used as the synthesis scan day + edited_at stamp. */
  scanDay: string;
  /** All variants in the cluster INCLUDING the canonical row's own markdown. */
  variantMarkdowns: VariantMarkdown[];
}): Promise<MergedMarkdowns> {
  const { canonicalName, accountName, canonicalState, scanDay, variantMarkdowns } = args;

  // Gather concatenated prior bullets per section. Pre-prune transients
  // against scanDay so the LLM never sees expired items (matches D23).
  const priorGeneralContext = concatSections(variantMarkdowns, (md) =>
    md ? extractContextSection(md) : null,
  );
  const priorGeneralTransientRaw = concatSections(variantMarkdowns, (md) =>
    md ? extractTransientSection(md) : null,
  );
  const priorGeneralTransient = pruneExpiredTransientBullets(
    priorGeneralTransientRaw,
    scanDay,
  );

  const priorSensitiveContext = concatSensitive(variantMarkdowns, (md) =>
    md ? extractContextSection(md) : null,
  );
  const priorSensitiveTransientRaw = concatSensitive(variantMarkdowns, (md) =>
    md ? extractTransientSection(md) : null,
  );
  const priorSensitiveTransient = pruneExpiredTransientBullets(
    priorSensitiveTransientRaw,
    scanDay,
  );

  const atAGlanceMap = campaignFieldsAsMap(canonicalState);
  const bullets = renderAtAGlanceBullets({
    entityType: 'campaign',
    campaignState: canonicalState,
  });

  // Short-circuit: if NONE of the variants had any prior bullets in any
  // section, there's no prose to merge. Skip the LLM call and assemble a
  // canonical doc that's just edited_at + at-a-glance + empty Context.
  const anyPriorPresent =
    !!priorGeneralContext ||
    !!priorGeneralTransient ||
    !!priorSensitiveContext ||
    !!priorSensitiveTransient;
  if (!anyPriorPresent) {
    return {
      status: assembleStatusMarkdown({
        editedAt: scanDay,
        bullets,
        contextProse: '',
      }),
      sensitive: null,
      skippedSynthesis: true,
    };
  }

  const renderedPrompt = renderStatusSynthesisV1Prompt({
    entityType: 'campaign',
    entityName: canonicalName,
    parentContext: `account: ${accountName}`,
    currentContextBullets: priorGeneralContext,
    currentSensitiveBullets: priorSensitiveContext,
    currentGeneralTransientBullets: priorGeneralTransient,
    currentSensitiveTransientBullets: priorSensitiveTransient,
    scanDay,
    atAGlanceJson: JSON.stringify(atAGlanceMap, null, 2),
    approvedFieldChangesJson: JSON.stringify([], null, 2),
    approvedAdditionalUpdatesJson: JSON.stringify([], null, 2),
  });

  const res = await defaultLlm.complete({
    model: MODEL,
    temperature: TEMPERATURE,
    prompt: renderedPrompt,
    tag: `campaign_merge.${STATUS_SYNTHESIS_V1_VERSION}`,
  });

  const parsed = parseQuadContextOutput(res.text);

  const status = assembleStatusMarkdown({
    editedAt: scanDay,
    bullets,
    contextProse: parsed.generalContext,
    transientProse: parsed.generalTransient,
  });
  const sensitive =
    parsed.sensitiveContext || parsed.sensitiveTransient
      ? assembleSensitiveStatusMarkdown({
          editedAt: scanDay,
          contextProse: parsed.sensitiveContext,
          transientProse: parsed.sensitiveTransient,
        })
      : null;

  logger.info(
    {
      canonicalName,
      variantCount: variantMarkdowns.length,
      hadGeneralContext: !!priorGeneralContext,
      hadGeneralTransient: !!priorGeneralTransient,
      hadSensitiveContext: !!priorSensitiveContext,
      hadSensitiveTransient: !!priorSensitiveTransient,
      mergedHasSensitive: !!sensitive,
    },
    '[campaign-merge-synthesizer] merged markdown via status-synthesis prompt',
  );

  return { status, sensitive, skippedSynthesis: false };
}
