/* eslint-disable */
// ╔════════════════════════════════════════════════════════════════════════════╗
// ║                                                                            ║
// ║   ⚠⚠⚠   MIRRORED FILE — KEEP IN LOCKSTEP   ⚠⚠⚠                            ║
// ║                                                                            ║
// ║   This file is a DUPLICATE of                                              ║
// ║                                                                            ║
// ║     gcp-universal-backend/src/modules/integrations/google-drive/           ║
// ║       drive.status-synthesis-prompt.ts                                     ║
// ║                                                                            ║
// ║   Both copies encode the same status_markdown synthesis surface:           ║
// ║     - STATUS_SYNTHESIS_V1_VERSION constant                                 ║
// ║     - renderStatusSynthesisV1Prompt (the Context-only prompt template)    ║
// ║     - at-a-glance bullet rendering (accountFieldsAsMap/                    ║
// ║       campaignFieldsAsMap/renderAtAGlanceBullets)                          ║
// ║     - assembleStatusMarkdown (edited_at header + bullets + Context)        ║
// ║     - extractContextSection (parses prior stored doc → just-the-prose)     ║
// ║     - postProcessContext (peels LLM-emitted fences/headers)                ║
// ║     - formatBudget (consistent currency rendering)                         ║
// ║                                                                            ║
// ║   Why duplicated:                                                          ║
// ║     - Production synthesis runs in GUB inside applyDecisions.              ║
// ║     - The backfill-dryrun.ts script in gub-drive-sync needs to produce    ║
// ║       byte-faithful output for prompt iteration; pre-mirror it had its    ║
// ║       own inline copy that drifted away from production within one        ║
// ║       prompt edit.                                                         ║
// ║     - Same mirroring pattern as drive.schema.ts (LOUD banner + edit-in-   ║
// ║       lockstep rule). Avoids release ceremony of a shared @gub package.   ║
// ║                                                                            ║
// ║   RULES WHEN EDITING:                                                      ║
// ║     1. Edit BOTH files in the SAME commit (cross-repo if needed).         ║
// ║     2. When the prompt body changes meaningfully, bump VERSION in BOTH    ║
// ║        files (audit trail correlates output quality to prompt versions). ║
// ║     3. If you change the at-a-glance bullet labels or formatting, the    ║
// ║        diff in stored *_changes.value_text for property='status_markdown' ║
// ║        will spike — that's expected, not a bug.                           ║
// ║     4. If divergence is suspected, do a literal diff against the GUB     ║
// ║        copy — drift causes dry-run output to lie about what production    ║
// ║        will produce, which defeats the whole point of the dryrun tool.    ║
// ║                                                                            ║
// ║   Eventual home: shared @gub/drive-prompts package once we've got a       ║
// ║   reason to introduce release ceremony. Not pre-launch.                   ║
// ║                                                                            ║
// ╚════════════════════════════════════════════════════════════════════════════╝
/* eslint-enable */

/**
 * status-synthesis.ts — single source of truth for status_markdown
 * synthesis prompt + assembly.
 *
 * The stored doc has three pieces, assembled by code (NOT by the LLM):
 *
 *   _edited_at: YYYY-MM-DD_     ← code stamps, today's date (D24)
 *
 *   ## At a glance              ← code renders from CurrentState (D2, D11)
 *   - Status: …
 *   - …
 *
 *   ## Context                  ← LLM-written prose (only this is generated)
 *   <free-form prose>
 *
 * Per D11 (originally "LLM renders bullets verbatim", reversed in favor of
 * code-render to eliminate drift risk entirely) the prompt asks ONLY for
 * the Context prose body. Bullets are structured data; we don't round-trip
 * them through an LLM. The edited_at header is the staleness signal per
 * D24 — readers infer freshness from the date relative to known field
 * changes.
 *
 * Why hardcoded (not in prompt_presets, per D15):
 *   The other three Drive prompts live in prompt_presets — they're
 *   operational knobs tunable in gub-admin. This one writes the canonical
 *   snapshot of an account/campaign; we want git history on every change,
 *   not a runtime UI edit.
 */

import type { AccountCurrentState, CampaignCurrentState } from './schema';

export const STATUS_SYNTHESIS_V1_VERSION = 'status-synthesis-v1';

// ── Prompt template ─────────────────────────────────────────────────────────

export interface StatusSynthesisV1Inputs {
  entityType: 'campaign' | 'account' | 'piece';
  entityName: string;
  /** Short string describing the parent ("account: Acme Corp"), or null. */
  parentContext: string | null;
  /**
   * The prior `## Context` body of `status_markdown` as raw bullet text
   * (one `- bullet` per line), or null for first creation. Callers use
   * `extractContextSection()` to strip the (stale) edited_at header +
   * (about-to-be-rerendered) at-a-glance block before passing the
   * bullets in. The LLM merges these with the new approved general
   * bullets.
   */
  currentContextBullets: string | null;
  /**
   * The prior `## Context` body of `status_sensitive_markdown` as raw
   * bullet text. Null for first creation OR when the entity has no
   * sensitive content yet. Per D29 this is a SEPARATE COLUMN — the LLM
   * merges within the sensitive tier only.
   */
  currentSensitiveBullets: string | null;
  /**
   * The prior `## Transient` body of `status_markdown` as raw bullet
   * text, PRE-PRUNED by the caller — only bullets whose `[expires: ...]`
   * date is on/after the current scan day. Null when there are no
   * surviving transient items (or the entity has no Transient section).
   * Per D23.
   */
  currentGeneralTransientBullets: string | null;
  /**
   * The prior `## Transient` body of `status_sensitive_markdown`,
   * pre-pruned. Null when there are no surviving sensitive transient
   * items.
   */
  currentSensitiveTransientBullets: string | null;
  /**
   * The current scan day in YYYY-MM-DD form. Used by the LLM to compute
   * default `[expires: ...]` markers (scan day + 14 days unless the
   * source specifies a date).
   */
  scanDay: string;
  /**
   * JSON-stringified Record<label, value> of the at-a-glance bullets.
   * Provided to the LLM for REFERENCE ONLY so its merge stays coherent
   * with the structured truth; the LLM does NOT re-emit it.
   */
  atAGlanceJson: string;
  approvedFieldChangesJson: string;
  /**
   * JSON array of `{text, source_file_ids, sensitive?: boolean | null}`.
   *   - `sensitive: true`  → reviewer explicitly tagged sensitive (forward sync)
   *   - `sensitive: false` → reviewer explicitly kept general
   *   - `sensitive: null | absent` → backfill / unclassified; LLM judges
   *     per the rubric.
   * Same array carries all three cases.
   */
  approvedAdditionalUpdatesJson: string;
}

const TEMPLATE = `You are merging the bullet lists for a {{entity_type}} status snapshot. Your output spans TWO orthogonal axes:

  - SENSITIVITY (access tier): general or sensitive — two separate stored columns.
  - DURABILITY (lifespan): durable (## Context) or transient (## Transient, with [expires: YYYY-MM-DD]).

Four output buckets total. You output all four.

# Where this fits

Two stored blobs, assembled by code:

  status_markdown (general):
    1. "edited_at" header line — code stamps.
    2. "## At a glance" bullet block — code renders from current entity
       columns. Provided below FOR YOUR REFERENCE ONLY so your merge
       stays coherent with the structured truth. Do NOT re-emit it.
    3. "## Context" bulleted list — durable general bullets (YOUR JOB).
    4. "## Transient" bulleted list — time-bound general bullets with
       [expires: YYYY-MM-DD] markers (YOUR JOB).

  status_sensitive_markdown (sensitive):
    1. "edited_at" header line — code stamps.
    2. "## Context" bulleted list — durable sensitive bullets.
    3. "## Transient" bulleted list — time-bound sensitive bullets.

Both tiers can carry transient content. Sensitivity (access) and durability
(lifespan) are independent. The four output sections cover the cross-product.

Context (any tier) is the accumulating durable record. Transient is for
in-progress work, deadlines, "decision due by X" — things that should
disappear from the active doc once their time has passed. Each fact is
its own bullet; lists grow as scans contribute.

# Sensitivity model (D28, D29)

The tier of a bullet is determined by what THE BULLET reveals to a reader, not the lineage of its source. Higher urgency, broader operational concern, or strong project risk does NOT make a bullet sensitive — those signals belong in general so the team can operate on them.

SENSITIVE = the bullet exposes one of the following SPECIFIC categories. Each is narrow on purpose.

  1. SPECIFIC DOLLAR FIGURES — contracts, fees, waivers, write-offs, budget overruns or underruns with a specific number attached. "We're $200K over budget" is sensitive. "We're tracking budget tightly" is general.

  2. NAMED-PERSON HR / PERFORMANCE CONTENT — terminations, performance assessments, role removals, hiring decisions tied to a specific named individual. "Bob was removed at client's request" is sensitive. "The team has been adjusted for capacity" is general.

  3. AD HOMINEM CONTENT — criticisms or grievances naming a specific person. "Sarah has been struggling with delivery" is sensitive. "Delivery has been challenging" is general.

  4. EMOTIONALLY CHARGED EVENTS — accounts of conflicts, blowups, escalations naming specific people or moments. "CMO yelled in the May 12 review" is sensitive. "The May 12 review surfaced budget tensions" is general.

  5. EMBARGOED CLIENT MOVES — not-yet-announced launches, acquisitions, leadership transitions, agency reviews. "Client is in agency review, undisclosed" is sensitive. "Client expects formal review cycles" is general.

  6. PERSONAL FINANCIAL / COMPENSATION — comp, equity, ratios, personal financial info about named individuals.

  7. CONFIDENTIAL BUSINESS REASONING BEHIND DECISIONS — timeline tied to M&A close, securities filings, executive transitions. "Launch is timed to the Q2 board meeting" is sensitive ONLY if the board meeting is confidential / undisclosed. "Launch is timed for NFL Week 1" is general.

GENERAL = everything else. Project risks at the team level. Urgency signals. Team capacity / workload observations not naming specific people. Decisions about how to handle the work. Brand voice, positioning, deliverables. Role assignments. Lessons learned. Process notes. Account / team structure. Industry posture. Market signals.

KEEP-IN-GENERAL anchor cases (real false-positive captures — DO NOT promote these to sensitive):
  - "The agency is concerned about the client-side team's capacity, which poses a risk to the project timeline." — project-management observation, no specific names or numbers
  - "The Q3 deadline is hard; budget cycle constraint creates pressure" — timeline pressure without specific confidential reasoning
  - "Maya is the creative lead on the campaign" — role assignment, not criticism
  - "Brand voice is dark, cinematic, neo-noir" — creative direction
  - "Client decision-making has been slow this quarter" — operational signal anyone should see

SENSITIVE anchor cases (DO route to sensitive):
  - "CMO escalated over a $200K overrun on May 12 — threatened account review" — specific dollar + emotional event
  - "Anomaly removed Bob at client's request May 2024" — named-person HR action
  - "Sarah has been struggling with delivery on this account" — ad hominem
  - "Client is in undisclosed agency review process" — embargoed move
  - "Launch is tied to the confidential June M&A close" — confidential business reasoning

ASYMMETRIC TOLERANCE: when uncertain whether a bullet is sensitive, default to GENERAL. The cost of over-gating operational signals (team loses visibility into project risks, capacity concerns, timeline pressure) is real and immediate. Sensitive is for SPECIFIC items in the seven categories above — narrow on purpose. If you can't point to which numbered category a bullet matches, it belongs in general.

DERIVATIVE rule: when a bullet IS sensitive (passes the test above), also produce a GENERAL bullet capturing the safe-to-share lesson — only if a useful general lesson exists. Examples:

  - Sensitive observation: "CMO yelled about a $200K budget overrun on May 12; threatened to put account in review"
  - Sensitive bullet (raw): "CMO escalated over a $200K budget overrun on May 12 — threatened account review [src: 1abc]"
  - General bullet (derivative): "{{entity_name}} is highly sensitive to budget transparency; over-communicate budget impacts proactively"
  - The general bullet does NOT name the dollar amount, the incident, or the person. It carries the actionable lesson.

  - Sensitive observation: "Bob from Anomaly was removed from the account at client's request"
  - Sensitive bullet (raw): "Anomaly removed Bob from the account May 2024 at client's request [src: 1xyz]"
  - General bullet (derivative): "{{entity_name}} expects senior-leadership presence in account interactions; junior staff need close supervision"

If no useful general derivative exists, emit only the sensitive bullet.

# Durability model (D23)

TRANSIENT = the bullet describes a TASK in progress, a CALENDAR-BOUND event, OR a claim whose truth depends on the campaign being IN-MARKET or a SEASON being CURRENT. Examples that anchor the right answer:

  - "Kat is polishing the 'fun fact' element in Figma" — task in progress. TRANSIENT. Default expires: scan day + 14d.
  - "Brief due to client by July 15" — explicit deadline. TRANSIENT. Expires: 2025-07-22 (deadline + 7d buffer).
  - "Awaiting client signoff on creative direction" — pending decision. TRANSIENT. Default 14d.
  - "Photoshoot scheduled for August 12" — bounded event. TRANSIENT. Expires: 2025-08-19.

Two additional TRANSIENT categories that LOOK durable but aren't — the failure mode is treating these as facts and letting them go stale in Context after the season ends or the campaign exits market:

  - CAMPAIGN-ACTIVE STATE: any claim describing the current configuration of an in-market campaign — hero spots, lead creative, primary placements, in-flight schedules, current asset call-outs, "the campaign is running with…". True only WHILE the campaign is trafficking. Once the campaign exits market, the claim is historical, not current.
    - "Fall Equinox campaign is led by hero broadcast spot 'Coach Em Up :30'" — campaign-active state in a seasonal window. TRANSIENT. Expires: end of Fall (Nov 30) in scan day's year.
    - "Q3 primary cut is the :30; supplementary :15s rolling on social" — quarter-bound in-market state. TRANSIENT. Expires: Sep 30.
    - "Holiday creative running on YouTube preroll + CTV" — in-market schedule. TRANSIENT. Expires: Jan 31 of the following year.
    Default expiration when no seasonal/quarterly signal AND no entity ends_at is visible: scan day + 84d (12 weeks, typical in-market window). If the entity's at-a-glance shows ends_at, USE THAT DATE — it's the campaign's actual end and beats the heuristic.

  - SEASONAL SCOPE: any statement bound to a named season or run window — Fall / Spring / Summer / Winter / Holiday / Back-to-School / Q1-Q4. Anchor expiration to end-of-season relative to scan day's year. If scan day has already passed that anchor, use the next year's.
      Winter / Q1            → Mar 31
      Spring / Q2            → Jun 30
      Summer / Q3            → Sep 30
      Fall / Q4              → Nov 30
      Holiday                → Jan 31 (following year)
      Back-to-School         → Sep 30

DURABLE = facts about the engagement that don't expire and survive campaigns coming and going. Roles, collaborations, positioning, brand traits, decisions that have been made (not pending). The carve-out matters because collaboration / role assignments LOOK like they could be transient but aren't — they describe HOW the work is structured, which persists. Anchor cases:

  - "Acme is doing photography production" — collaboration assignment. DURABLE.
  - "Maya is the creative lead" — role assignment. DURABLE.
  - "Brand voice is dark, neo-noir" — positioning fact. DURABLE.
  - "Q3 deadline is hard; budget cycle constraint" — fact about a constraint, not a task. DURABLE.
  - "Client prefers blue / dark palettes" — preference fact. DURABLE.

The test: "Does the truth of this claim require the campaign to be IN-MARKET, or a SEASON to be CURRENT, or a TASK to be in progress?" → transient. Is it a structural fact (role / collaboration / preference / positioning) that survives campaigns coming and going? → durable.

DEFAULT EXPIRATION (when no explicit date in source AND no seasonal/quarterly anchor applies): scan day + 14 days for tactical tasks; scan day + 84 days (12 weeks) for campaign-active claims with no end signal. The current scan day is {{scan_day}}. If the source explicitly states a date or range, use that (plus a 7-day buffer for deadlines, to keep them visible during their own week). If the entity's at-a-glance shows ends_at, prefer that over heuristic defaults.

EXPIRES FORMAT: every transient bullet ends with "[expires: YYYY-MM-DD]" immediately before any "[src: ...]" citation. Example:
  - "Kat polishing the 'fun fact' element in Figma [expires: 2026-06-11] [src: 1abc]"

PRUNING: bullets whose [expires:] is BEFORE the scan day are automatically removed by the caller before you see them — you never receive expired bullets as prior state. Just merge the surviving ones.

# Per-bullet input flag

Each NEW APPROVED BULLET item carries an optional \`sensitive\` field:
  - \`sensitive: true\`  → reviewer explicitly tagged sensitive. Place in SENSITIVE tier. Consider a general derivative.
  - \`sensitive: false\` → reviewer explicitly kept general. Place in GENERAL tier. Do NOT promote.
  - \`sensitive: null\` or absent → unclassified (backfill mode). Classify via the rubric above. Lean conservative: when ambiguous about whether something is sensitive, err toward sensitive (false-positives are cheap because a useful derivative still propagates).

# Merge operations (D25, per tier)

Apply these to EACH tier independently (general bullets merge with prior general; sensitive merge with prior sensitive). Cross-tier supersession does not exist — the raw sensitive and the general derivative are parallel by design.

  A. DEDUPLICATE — drop a new bullet when it asserts the same fact as a prior bullet at the same tier. Keep one version (prefer the prior wording if serviceable).
  B. SUPERSESSION WITH PRESERVATION — when a new bullet contradicts a prior bullet at the same tier, KEEP both: the prior rewritten to past-tense / date-bounded form, the new as-is. Multiple supersessions chain.
  C. APPEND — otherwise add to the list.

# Hard rules

1. Output ALL FOUR sections using these exact delimiters (literal lines):
     === GENERAL_CONTEXT ===
     <durable general bullets, one per line, each starting with "- ">
     === GENERAL_TRANSIENT ===
     <transient general bullets with [expires: YYYY-MM-DD] markers>
     === SENSITIVE_CONTEXT ===
     <durable sensitive bullets>
     === SENSITIVE_TRANSIENT ===
     <transient sensitive bullets with [expires: YYYY-MM-DD] markers>
   If a section has zero bullets, leave it empty (the delimiter line is still present). All four delimiters MUST appear, even if some sections are empty.
2. Do NOT include any other headers ("## Context", "## Transient", "## At a glance", "edited_at", entity name, titles).
3. Preserve source citations. Every bullet retains its "[src: <fileId>]" citation. Transient bullets carry BOTH "[expires: ...]" AND "[src: ...]". When a superseded bullet is rewritten to past-tense, keep its original [src: ...].
4. Do NOT invent facts not present in the inputs. Do NOT consolidate multiple bullets into one summary bullet. Do NOT add interpretation or narrative connective tissue.
5. Do NOT restate, paraphrase, or reference the at-a-glance bullets in ANY section.
6. APPROVED FIELD CHANGES are reasoning context — you do not emit bullets FOR them.
7. Preserve insertion order roughly within each section: prior bullets first (with any rewrites in place), then any newly-appended bullets.

# Inputs

ENTITY TYPE: {{entity_type}}
ENTITY NAME: {{entity_name}}
PARENT CONTEXT: {{parent_context}}
SCAN DAY: {{scan_day}}

AT A GLANCE (reference only — do NOT re-emit):
\`\`\`json
{{at_a_glance_json}}
\`\`\`

APPROVED FIELD CHANGES (just passed review in this batch; for reasoning, not output):
\`\`\`json
{{approved_field_changes_json}}
\`\`\`

NEW APPROVED BULLETS (this batch; each carries optional sensitive flag — see rubric):
\`\`\`json
{{approved_additional_updates_json}}
\`\`\`

PRIOR GENERAL CONTEXT (existing durable bullets from status_markdown):
{{current_context_bullets}}

PRIOR GENERAL TRANSIENT (existing transient bullets from status_markdown, already pruned of expired):
{{current_general_transient_bullets}}

PRIOR SENSITIVE CONTEXT (existing durable bullets from status_sensitive_markdown):
{{current_sensitive_bullets}}

PRIOR SENSITIVE TRANSIENT (existing transient bullets from status_sensitive_markdown, already pruned):
{{current_sensitive_transient_bullets}}

# Now output ALL FOUR merged bullet sections using the delimiters. Each line "- <bullet text> [src: <fileId>]" (transient bullets also carry [expires: YYYY-MM-DD]). No code fences, no preamble, no trailing commentary.
`;

export function renderStatusSynthesisV1Prompt(inputs: StatusSynthesisV1Inputs): string {
  return TEMPLATE
    .replace(/{{entity_type}}/g, inputs.entityType)
    .replace(/{{entity_name}}/g, inputs.entityName)
    .replace(/{{parent_context}}/g, inputs.parentContext ?? '(none)')
    .replace(/{{scan_day}}/g, inputs.scanDay)
    .replace(/{{at_a_glance_json}}/g, inputs.atAGlanceJson)
    .replace(/{{approved_field_changes_json}}/g, inputs.approvedFieldChangesJson)
    .replace(/{{approved_additional_updates_json}}/g, inputs.approvedAdditionalUpdatesJson)
    .replace(
      /{{current_context_bullets}}/g,
      inputs.currentContextBullets ?? '(null — first creation, emit the new approved general bullets as-is)',
    )
    .replace(
      /{{current_sensitive_bullets}}/g,
      inputs.currentSensitiveBullets ?? '(null — no sensitive context yet)',
    )
    .replace(
      /{{current_general_transient_bullets}}/g,
      inputs.currentGeneralTransientBullets ?? '(null — no surviving transient general items)',
    )
    .replace(
      /{{current_sensitive_transient_bullets}}/g,
      inputs.currentSensitiveTransientBullets ?? '(null — no surviving transient sensitive items)',
    );
}

// ── At-a-glance bullet rendering ────────────────────────────────────────────
//
// Bullets are code-rendered from CurrentState (which itself is built once
// in drive.schema.ts via buildAccountCurrentState/buildCampaignCurrentState).
// Both repos call into these same helpers so production and dry-run
// produce byte-identical output for the same entity state.

export function accountFieldsAsMap(s: AccountCurrentState): Record<string, string> {
  return {
    Status: s.status ?? '—',
    Industry: s.industry ?? '—',
    'Primary contact': s.primary_contact_name ?? '—',
    'Contact email': s.primary_contact_email ?? '—',
    'Account exec': s.account_exec_staff_id ?? '—',
    Notes: s.notes ?? '—',
  };
}

export function campaignFieldsAsMap(s: CampaignCurrentState): Record<string, string> {
  return {
    Stage: s.status ?? '—',
    Budget: s.budget ? formatBudget(s.budget) : '—',
    Awarded: s.awarded_at ?? '—',
    Launch: s.live_at ?? '—',
    Ends: s.ends_at ?? '—',
  };
}

/**
 * One bullet per entry from the field map, "- Label: value" format.
 * Order matches the map's insertion order (which is fixed in the helpers
 * above).
 */
export function renderAtAGlanceBullets(args: {
  entityType: 'account' | 'campaign' | 'piece';
  accountState?: AccountCurrentState | null;
  campaignState?: CampaignCurrentState | null;
  /** Pieces have no structured columns; their at-a-glance is name + owner. */
  pieceFields?: Record<string, string> | null;
}): string {
  const map =
    args.entityType === 'account'
      ? accountFieldsAsMap(
          args.accountState ?? throwBadInput('accountState required for entityType=account'),
        )
      : args.entityType === 'piece'
        ? (args.pieceFields ?? throwBadInput('pieceFields required for entityType=piece'))
        : campaignFieldsAsMap(
            args.campaignState ?? throwBadInput('campaignState required for entityType=campaign'),
          );
  return Object.entries(map)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n');
}

function throwBadInput(message: string): never {
  throw new Error(`[status-synthesis] ${message}`);
}

/**
 * Budget is stored as CampaignCurrentState.budget = numeric string (e.g.
 * "250000.00"). Display form is currency. Falls back to the raw string
 * if it can't be parsed as a finite number.
 */
export function formatBudget(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// ── Doc assembly + parsing ──────────────────────────────────────────────────

/**
 * Code-render the canonical status_markdown (general) shape. Stable
 * formatting so downstream diffing in *_changes is meaningful.
 *
 * Per D23: optional `## Transient` section follows `## Context` when
 * there's transient content this scan. Empty Transient section omitted.
 */
export function assembleStatusMarkdown(args: {
  editedAt: string;
  bullets: string;
  contextProse: string;
  transientProse?: string;
}): string {
  const lines: string[] = [
    `_edited_at: ${args.editedAt}_`,
    '',
    '## At a glance',
    args.bullets,
    '',
    '## Context',
    args.contextProse.trim(),
  ];
  const transient = (args.transientProse ?? '').trim();
  if (transient.length > 0) {
    lines.push('', '## Transient', transient);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Code-render the status_sensitive_markdown shape (per D29). No
 * "## At a glance" — structured fields are always general (SQL truth).
 * Optional `## Transient` per D23.
 */
export function assembleSensitiveStatusMarkdown(args: {
  editedAt: string;
  contextProse: string;
  transientProse?: string;
}): string {
  const lines: string[] = [
    `_edited_at: ${args.editedAt}_`,
    '',
    '## Context',
    args.contextProse.trim(),
  ];
  const transient = (args.transientProse ?? '').trim();
  if (transient.length > 0) {
    lines.push('', '## Transient', transient);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Pull the body of the `## Context` section out of a previously-stored
 * status_markdown so the LLM only sees the prose it should preserve/
 * update — not the (stale) edited_at line or the (about-to-be-rerendered)
 * at-a-glance block.
 *
 * Tolerant of: missing edited_at header, differently-cased headers,
 * trailing whitespace, extra blank lines. Returns null when no Context
 * section is present (caller treats as "first creation").
 */
export function extractContextSection(stored: string): string | null {
  const re = /(^|\n)##\s+Context\s*\n([\s\S]*?)(?=\n##\s|$)/;
  const m = stored.match(re);
  if (!m || !m[2]) return null;
  const body = m[2].trim();
  return body.length > 0 ? body : null;
}

/**
 * Pull the body of the optional `## Transient` section out of a stored
 * status blob. Returns null when no Transient section exists (entity
 * hasn't had transient content, or all transient bullets have expired).
 * Per D23.
 */
export function extractTransientSection(stored: string): string | null {
  const re = /(^|\n)##\s+Transient\s*\n([\s\S]*?)(?=\n##\s|$)/;
  const m = stored.match(re);
  if (!m || !m[2]) return null;
  const body = m[2].trim();
  return body.length > 0 ? body : null;
}

/**
 * Prune Transient bullets whose `[expires: YYYY-MM-DD]` marker is BEFORE
 * the asOfDate (the scan day being processed). Returns the surviving
 * bullets joined back into a single string, or null when nothing
 * survives.
 *
 * Tolerant of bullets without an expires marker — they're treated as
 * surviving (don't drop bullets the LLM wrote incorrectly; let the
 * supersede pass re-shape them next time).
 *
 * Per D23: pruning happens BEFORE synthesis, so the LLM never sees
 * expired bullets as prior state.
 */
export function pruneExpiredTransientBullets(
  transientBody: string | null,
  asOfDate: string,
): string | null {
  if (!transientBody) return null;
  const lines = transientBody.split('\n');
  const survivors: string[] = [];
  const expiresRe = /\[expires:\s*(\d{4}-\d{2}-\d{2})\s*\]/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const m = trimmed.match(expiresRe);
    if (!m || !m[1]) {
      // No expires marker — keep (defensive; the LLM should always
      // emit one, but if it didn't, pruning is the wrong tool to
      // address the bug).
      survivors.push(line);
      continue;
    }
    if (m[1] >= asOfDate) {
      survivors.push(line);
    }
    // else: expired, drop silently.
  }
  if (survivors.length === 0) return null;
  return survivors.join('\n');
}

/**
 * Strip the usual Gemini markdown-fence wrappers and leading/trailing
 * chatter. The prompt asks for raw prose with no preamble, but
 * defense-in-depth: peel one common wrapper, and also strip a leading
 * `## Context` if the LLM emitted it despite being told not to.
 */
export function postProcessContext(raw: string): string {
  let s = raw.trim();
  const fence = s.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```$/);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }
  s = s.replace(/^##\s+Context\s*\n/, '').trim();
  s = s.replace(/^##\s+At a glance[\s\S]*?(?=\n##\s|$)/, '').trim();
  s = s.replace(/^##\s+Context\s*\n/, '').trim();
  return s;
}

/**
 * Parse the quad-output synthesis response into the four bucket bodies.
 * The prompt asks the LLM to delimit with literal lines:
 *
 *   === GENERAL_CONTEXT ===
 *   === GENERAL_TRANSIENT ===
 *   === SENSITIVE_CONTEXT ===
 *   === SENSITIVE_TRANSIENT ===
 *
 * Any section may be empty. Defense-in-depth: peels a code fence if the
 * LLM wrapped the whole response.
 *
 * If the LLM omits all four delimiters entirely (worst case), the whole
 * response is gated as SENSITIVE_CONTEXT (safer to hide from broad
 * readers than to leak).
 */
export function parseQuadContextOutput(raw: string): {
  generalContext: string;
  generalTransient: string;
  sensitiveContext: string;
  sensitiveTransient: string;
} {
  let s = raw.trim();
  const fence = s.match(/^```(?:markdown)?\s*\n([\s\S]*?)\n```$/);
  if (fence && fence[1]) {
    s = fence[1].trim();
  }

  // Line-based parser — robust against:
  //   - Back-to-back delimiters with no content between them
  //     (the prior regex's \n? would swallow the only boundary newline)
  //   - CRLF line endings (\r?\n split below)
  //   - Leading whitespace on delimiter lines
  //   - Missing trailing newline before the next delimiter
  //
  // The delimiter regex requires the marker to be the ENTIRE line (modulo
  // leading/trailing whitespace) — so content bullets that happen to
  // mention "=== GENERAL_TRANSIENT ===" as inline text aren't mistaken
  // for delimiters.
  const DELIM_RE = /^\s*===\s*(GENERAL_CONTEXT|GENERAL_TRANSIENT|SENSITIVE_CONTEXT|SENSITIVE_TRANSIENT)\s*===\s*$/;
  const lines = s.split(/\r?\n/);
  const anyMarker = lines.some((line) => DELIM_RE.test(line));
  if (!anyMarker) {
    // Total failure — gate the whole blob as sensitive durable.
    return {
      generalContext: '',
      generalTransient: '',
      sensitiveContext: postProcessContext(s),
      sensitiveTransient: '',
    };
  }

  const buckets: Record<
    'GENERAL_CONTEXT' | 'GENERAL_TRANSIENT' | 'SENSITIVE_CONTEXT' | 'SENSITIVE_TRANSIENT',
    string[]
  > = {
    GENERAL_CONTEXT: [],
    GENERAL_TRANSIENT: [],
    SENSITIVE_CONTEXT: [],
    SENSITIVE_TRANSIENT: [],
  };
  let current: keyof typeof buckets | null = null;
  for (const line of lines) {
    const m = line.match(DELIM_RE);
    if (m && m[1]) {
      current = m[1] as keyof typeof buckets;
      continue;
    }
    if (current) buckets[current].push(line);
  }

  return {
    generalContext: postProcessContext(buckets.GENERAL_CONTEXT.join('\n')),
    generalTransient: postProcessContext(buckets.GENERAL_TRANSIENT.join('\n')),
    sensitiveContext: postProcessContext(buckets.SENSITIVE_CONTEXT.join('\n')),
    sensitiveTransient: postProcessContext(buckets.SENSITIVE_TRANSIENT.join('\n')),
  };
}
