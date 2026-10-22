/**
 * thinking.ts — which thinking level a Gemini call runs at (#69).
 *
 * GEMINI_THINKING_BY_TAG maps a call tag, or a short call-type name, to a
 * thinking level. A call whose tag has no entry sends no thinking
 * parameter and runs at the model's default (MEDIUM for gemini-3.5-flash),
 * which is what every call did before this map existed. An empty map is
 * the default and the rollback.
 *
 * Levels, not budgets: gemini-3.5-flash takes thinkingLevel MINIMAL, LOW,
 * MEDIUM or HIGH, and rejects a request that sets both thinkingLevel and
 * thinkingBudget with a 400. Capping maxOutputTokens is not a substitute:
 * thinking counts against that cap, so a tight cap truncates the answer.
 *
 * Config-free, so src/config.ts can parse the map with it.
 */

export const THINKING_LEVELS = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];
export type ThinkingMap = Record<string, ThinkingLevelName>;

/**
 * Short names for the call tags, usable as map keys. Matched by tag prefix
 * so a version bump of a preset or prompt keeps its short name.
 */
const CALL_TYPES: ReadonlyArray<readonly [prefix: string, callType: string]> = [
  ['drive.file_extraction.', 'interpret'],
  ['drive.distillation.', 'distill'],
  ['drive.structure_resolution.', 'classify'],
  ['drive.idea_extraction.', 'idea_extract'],
  ['drive.idea_match_merge.', 'idea_merge'],
  ['backfill.status-synthesis', 'synthesis'],
  ['campaign_merge.', 'campaign_merge'],
  ['campaign_cluster_detection.', 'cluster'],
  ['drive.asset_folder.', 'asset_folder'],
  ['drive.piece_derive.', 'piece_derive'],
  ['drive.field_heal.', 'heal'],
  ['drive.new_entity_extraction.', 'discover'],
];

/** The short call-type name of a tag, or null for a tag outside the table. */
export function callTypeOf(tag: string | undefined): string | null {
  if (!tag) return null;
  for (const [prefix, callType] of CALL_TYPES) {
    if (tag.startsWith(prefix)) return callType;
  }
  return null;
}

/**
 * Parse GEMINI_THINKING_BY_TAG. Throws on anything but a JSON object of
 * known levels, so a typo fails the job at startup instead of silently
 * running every call at the default.
 */
export function parseThinkingMap(raw: string): ThinkingMap {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('GEMINI_THINKING_BY_TAG must be a JSON object');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('GEMINI_THINKING_BY_TAG must be a JSON object');
  }
  const map: ThinkingMap = {};
  const callTypes = new Set(CALL_TYPES.map(([, callType]) => callType));
  for (const [key, level] of Object.entries(value)) {
    // A key must name a call type or a tag the table knows; a misspelt key
    // would otherwise leave its calls at the default level unnoticed.
    if (!callTypes.has(key) && callTypeOf(key) === null) {
      throw new Error(`GEMINI_THINKING_BY_TAG.${key} is not a call type or a known call tag`);
    }
    if (!(THINKING_LEVELS as readonly unknown[]).includes(level)) {
      throw new Error(`GEMINI_THINKING_BY_TAG.${key} must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    map[key] = level as ThinkingLevelName;
  }
  return map;
}

/**
 * The level for a call: an entry for the exact tag wins, then an entry for
 * the tag's call type; otherwise undefined (no thinking parameter).
 */
export function thinkingLevelFor(
  tag: string | undefined,
  map: ThinkingMap,
): ThinkingLevelName | undefined {
  if (!tag) return undefined;
  const exact = map[tag];
  if (exact) return exact;
  const callType = callTypeOf(tag);
  return callType ? map[callType] : undefined;
}
