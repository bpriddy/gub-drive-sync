# Status-markdown work plan

A new feature on top of the just-extracted gub-drive-sync pipeline: every
campaign and account gets a `status_markdown` blob — the canonical
human-readable snapshot, kept fresh by the LLM whenever a Drive review
batch is approved.

## Spirit

The structured fields (`status`, `budget`, `awarded_at`, etc.) are
canonical SQL truth — minimal, principled, baseline. They are
deliberately not exhaustive. Most of what a human needs to know about a
campaign or account doesn't fit a column.

`status_markdown` is where the *body* lives: structured fields rendered
as bullets at the top (so `SELECT status_markdown FROM campaigns WHERE
id=X` is the 30-second read), plus LLM-curated prose describing
project-level context that doesn't fit fields. The LLM's job is
distinguishing project-level context from day-to-day churn. Getting that
right is one of the most important things in this feature.

## Locked decisions

| # | Decision |
|---|---|
| D1 | Both `Campaign` and `Account` get a `status_markdown String? @db.Text` column. |
| D2 | Stored shape (general): `_edited_at: YYYY-MM-DD_` (top line, per D24) + `## At a glance` (every structured field as a label/value bullet, code-rendered from current entity columns) + `## Context` (bulleted list of atomic facts, per D25). Sensitive content lives in a separate column with its own shape — see D29. |
| D3 | Title and at-a-glance summary paragraph are **not** stored — composed at request time by the display surface from live column values. |
| D4 | `drive_change_proposals` gains a new `kind = 'additional_update'`, used for unstructured findings that don't fit the writable allowlist. |
| D5 | One `additional_update` row per entity per scan (batched). `property='__note__'` sentinel. `proposedValue = { items: [{text, source_file_id}, ...] }`. |
| D6 | Reviewer UI: edit + delete items inline on the additional_update card. No "add" button (preserves the human-reviews-AI contract). |
| D7 | Synthesis runs **inside GUB's `applyDecisions()`** request handler, synchronously, after the per-decision applies commit. Reviewer waits ~5–15s for the Gemini call. |
| D8 | Trigger: synthesis fires for any campaign or account that had ≥1 approved item in the batch (structured field_change OR new_entity OR additional_update). |
| D9 | Synthesis prompt input (β): `current_status_markdown` + just-approved items from this batch (field_change before/after, new_entity creates, additional_update items the reviewer kept) + the entity's current scalar field values post-batch + entity name + parent context. NOT prior status_markdown versions. |
| D10 | First-creation behavior: implicit. `current_status_markdown=null` is the signal the LLM uses to write from scratch vs. update. No explicit flag. |
| D11 | Drift discipline on the bullet block: prompt instructs the LLM to render structured field values verbatim (`"Budget: $250,000"`, never paraphrase). Tradeoff accepted; iterated via debug script. |
| D12 | New-entity flow: option (I + P). Discovery runs per-file interpretation on its sampled files; observations get written as an `additional_update` row sharing the new-entity `proposalGroupId`. The new-entity card grows an editable "Observations" section. On group approval: create entity + apply field overrides + take edited observations + synthesize v1 status_markdown — all in one transaction. New entities land already populated. |
| D13 | `DISCOVERY_FILE_BUDGET` drops from 5 → 2. Folders existing for hours/days with one or two files (typical: brief + transcript) should trigger detection. v1 status_markdown is sparse-but-real on day one; subsequent syncs enrich. |
| D14 | `changed_by` on the synthesis-driven `*_changes` row = reviewer's staff_id. The reviewer caused the change by approving the inputs; LLM authorship is a downstream consequence. |
| D15 | The synthesis prompt is a hardcoded TypeScript constant in `gub-drive-sync/src/drive/prompts/status-synthesis.v1.ts` (and a matching constant on the GUB side where the call happens). **Deliberate departure** from the existing `prompt_presets` DB pattern — this prompt is high-stakes enough to be git-tracked rather than runtime-editable. The three existing Drive prompts (file_extraction, distillation, new_entity) remain in `prompt_presets`. |
| D16 | Debug story: a script seeds a real proposal row against a chosen campaign/account and **prints the magic link**. The reviewer flow (existing UI + applyDecisions + synthesis) does the rest end-to-end. No bespoke synthesis-preview path. Iterate prompt by tweaking source, re-running script, clicking the link, watching the result. |
| D17 | `status_markdown` is NOT added to `CAMPAIGN_WRITABLE_FIELDS` / `ACCOUNT_WRITABLE_FIELDS`. The writable allowlist gates what the per-file LLM is allowed to propose as a structured field_change. Status is written via a different code path (synthesis after applyDecisions), so it doesn't belong in the allowlist. The `*_changes` audit row written by synthesis just carries `property='status_markdown'` as a string label — no validation against the writable allowlist there. |
| D18 | **Structured fields vs status_markdown is queryability vs narrative**, not correctness vs incorrectness. Structured fields exist to support SQL filter/aggregate ("all campaigns launching in June"). Status_markdown exists for human/LLM reads ("what's the status of Chevy?"). When the structured-extraction pipeline fails to map a fact into a structured field but the fact survives as a note in the markdown, the **blast radius is missed-from-aggregations, not lost-from-system**. Worth documenting because it justifies the rescue-to-note + heal design. |
| D19 | **Rescue-to-note** — when `distillAndEmit` validates a field_change and the field name or value is rejected, the LLM's observation text is DEMOTED into the `additional_update` (notes) batch instead of dropped. The reviewer sees the content as a note, the synthesis prompt sees it, the LLM's signal is preserved. A separate `drive_scan_logs` row with `category='diagnostic'` is written so dev team can observe "we keep failing on field X" → signal to add it to the allowlist. Reviewer never has to know about schema. |
| D20 | **Heal step in scanEntity** — runs FIRST in `scanEntity`, before `scanFolder`. Reads the entity's existing `status_markdown` and asks the LLM to extract HIGH-CONFIDENCE structured-field updates (filling nulls AND correcting existing values). **Auto-applied**, NOT proposal-and-review — the markdown the LLM is reading was already approved by the reviewer; re-reviewing structural extractions of approved content would be redundant noise. `changed_by` = seeded Drive Sync system staff (UUID `dcd5d8e3-0000-4000-a000-000000000001`). Audit trail via `*_changes` rows. Safety relies on the prompt's strict "high confidence" gate. |
| D21 | **CHECK constraint loosening** — `drive_change_proposals_entity_shape` was rewritten to enforce only invariants (kind/entity_type enum membership, account_id-or-campaign_id present except for new_entity proposals). The previous per-kind shape rules (e.g., "kind=new_entity requires proposal_group_id") were duplicating application-level invariants and forced a migration every time a new `kind` was added. Per-kind shape correctness is now enforced exclusively by the TypeScript writers + Zod validators. |
| D22 | **Scaling — mechanical chunking under LLM-as-reader.** The canonical reader of `status_markdown` is an LLM preparing a response to a user query, *not* a human. That reframing sets the scaling constraints: human reading attention is irrelevant; LLM context budget + synthesis cost are what bind. v1 ships single-file. Once accumulated state crosses a synthesis-cost threshold, the doc splits into mechanically-bounded chunks (`status.md`, `status-2.md`, …). **Chunk budget: ~6,000 tokens per chunk** (≈ 500 lines of typical mixed bullet/prose status content). Sized to keep a single chunk rewrite within Gemini 2.5 Flash's ~5–15s output-latency envelope (D7) while amortizing per-call overhead — smaller chunks pay round-trip cost too often; larger chunks bust D7 and degrade rewrite coherence. Chunks carry no topical meaning. Synthesis is a per-chunk rewrite pass — each chunk + candidate items → LLM → rewrites only chunks that change. Genuinely-new candidates tail-append: into the last chunk until it would exceed the token budget, then spawn a new chunk. No semantic classification, no append-only log, no time-based prominence. See "Scaling model" section below. |
| D23 | **Transient state — explicit per-line expiration, orthogonal to sensitivity.** Some content is important but time-bound (an in-progress task, a deadline, a "decision due by X"). Rather than detect transience semantically (brittle, and important-but-quiet durable items would get demoted), the synthesis prompt classifies each bullet as **durable** or **transient**. Transient bullets land in a `## Transient` section with an explicit `[expires: YYYY-MM-DD]` marker per line. Pre-synthesis prunes bullets where `[expires: ...]` is before the current scan's day — they disappear entirely (audit trail in `*_changes` preserves the historical doc snapshot if needed). Default expiration: **scan day + 14 days** unless the source explicitly states a date or range (then use that, with a 1-week buffer past it for deadlines). **Durable carve-out for collaboration / role assignments:** "Acme is doing photography production," "Maya is the creative lead," "Brand voice is dark, neo-noir" — these are facts about the engagement, not tasks. They stay in `## Context` (durable), no expiration. The durability test is "is this a TASK someone is doing right now?" If yes, transient. If it's a fact, role, or assignment, durable. **Transient × Sensitive are orthogonal:** either tier (general or sensitive) can carry transient bullets. So `status_markdown` can have `## Context` + `## Transient`, and `status_sensitive_markdown` can independently have its own `## Context` + `## Transient`. Sensitive transient is for things like "Bob's PIP decision due Aug 31" — both ephemeral and gated. Output format from synthesis is four delimited sections (`=== GENERAL_CONTEXT ===` / `=== GENERAL_TRANSIENT ===` / `=== SENSITIVE_CONTEXT ===` / `=== SENSITIVE_TRANSIENT ===`); code parses and assembles into the two stored blobs. |
| D24 | **`edited_at: YYYY-MM-DD` line at the top of every `status_markdown`.** Stamped by the synthesis writer. Serves as the freshness signal for any reader (human or LLM): if structured fields show changes more recent than this date, the prose is stale by that much. Replaces what would otherwise need to be a `status_markdown_synthesized_at` column + a detect-and-retry mechanism for synthesis failures. The staleness IS the doc — no engineering recovery needed. Synthesis failure → the doc keeps yesterday's `edited_at` until the next successful synthesis, and the gap is self-evident. |
| D25 | **Context is a bulleted list of atomic facts; LLM merges, never compresses.** A backfill dry-run produced 23 per-file observations → 3 prose paragraphs in Context. Compression was happening at two steps: distillation summarizing observations into prose "notes," then synthesis compressing those into paragraphs. Both were losing reviewable signal. Now: (a) **Distillation** does ONE merging op — collapse observations across files that assert the same fact (true dupes). No topical consolidation. Output `notes[]` carries 1:1 observation text. (b) **Synthesis** merges new approved bullets into the prior Context bullet list via three operations — **dedupe** (drop new bullets that repeat a prior bullet's fact), **supersession-with-preservation** (when a new bullet contradicts a prior one, KEEP both: the prior rewritten to past-tense / date-bounded form, the new as-is — never drop superseded history), and **append** (otherwise add to the list). Output is bullets, never prose. Justification: prose compression is lossy and unreviewable; supersession-with-preserve gives a contradiction-aware doc without erasing signal a future scan might need. Dedup is the actual value the LLM provides; narrative writing was anti-value. |
| D26 | **Folder-context surfaces as bullet text, not structured columns.** When a file's parent folder appears to be a meaningful collection (Fonts, Brand Assets, Briefs, References, Finals, Decks, etc.), the per-file extractor emits an observation naming the folder by its full path. The path lands inside the Context bullet text — no schema changes, no extended citation format. Rationale: (a) per-account naming convention varies too much for dedicated columns (`fonts_folder_id`, `brand_assets_folder_id`, …) to stay accurate; (b) the path is more useful to a human reader than a bare folder URL (they can navigate the parent and understand structure); (c) an answering LLM can present the path verbatim, or lazy-resolve path → folder ID via Drive API for a clickable deep link, only when a "where" query demands it. Cheap to revisit: if "where" queries become latency-sensitive, we add folder IDs to the bullet citation structure later. v1 trusts the LLM to surface folder names when they matter. |
| D27 | **Agency boilerplate is filtered at the per-file extractor — two layers, strict-on-ambiguity.** Anomaly is the agency producing the work; observations are about the CLIENT, not about Anomaly itself. Enforcement: **(1) HARD GATE** — files whose primary subject IS Anomaly (training material, intern programs, IAT model docs, agency capabilities decks, internal team org charts, methodology overviews) emit EMPTY arrays. The fact that the file sits in a client's Drive doesn't make its content about that client. **(2) POSITIVE TEST per-observation** — every emitted observation must mention at least one of: the named client/brand, the named campaign, a specific person on this engagement, or a specific decision/deliverable/risk about this work. If substituting another client's name for the current one would leave the sentence still true, it's boilerplate — drop. **Asymmetric tolerance** (key principle): false positives (kept boilerplate) are costly because status_markdown is the canonical client snapshot — noise degrades every future read; false negatives (missed non-standard practice because context couldn't disambiguate) are acceptable because the same fact will likely resurface in a later file with clearer context. So the prompt instructs the LLM to default to DROP when ambiguous. Anchor cases (DROP and KEEP examples from real scans) baked into the prompt as reference points. Single safety-net clause in heuristic-of-last-resort: a sentence that references Anomaly's general practice only as a *contrast* for what's being done specifically for this client (e.g. "Anomaly is using a 4-week cadence here vs. their usual 6-week") may be kept — but explicit "lean strict when ambiguous" framing prevents the LLM from treating that as license to keep everything. Earlier iteration history (migrations 20260527010000, 020000, 030000, 040000) shows the progression from soft guidance → hard gate → over-engineered carve-out → walked back to strict asymmetric. |
| D28 | **Binary sensitivity tier: general / sensitive — with narrow rubric + asymmetric tolerance toward GENERAL.** Two access tiers, not three. General = anyone with read access to the account/campaign. Sensitive = requires a separate per-entity grant (mechanism TBD; defer until first non-admin consumer needs it). **Backfill** auto-classifies via an LLM rubric that defines sensitive as seven SPECIFIC categories: (1) specific dollar figures, (2) named-person HR / performance content, (3) ad hominem content, (4) emotionally charged events naming specific people, (5) embargoed client moves, (6) personal financial / compensation, (7) confidential business reasoning behind decisions (M&A, securities filings). **Asymmetric tolerance (flipped from initial draft):** default to GENERAL when uncertain. Higher urgency, broader project-team scope, capacity concerns at the team level, timeline pressure — these are operational signals the team needs, NOT sensitive. The cost of over-gating operational signals (team loses visibility) is real and immediate; sensitive is reserved for SPECIFIC items in the seven categories. **Forward sync** uses reviewer per-item toggle on the additional_update card; default off (matches the general-leaning rubric). **DERIVATIVE rule:** when a bullet IS sensitive, LLM may also produce a GENERAL bullet capturing the safe-to-share lesson — the abstracted operational insight stripped of dollar amounts, names, and embargoed details. Cross-tier bullets describe the same fact at different abstraction levels; parallel content is by design. D25 merge (dedupe + supersede) runs per-tier. **Calibration history:** the original prompt was too greedy (caught "agency is concerned about client-side capacity → project timeline risk" as sensitive — an operational signal the team should see). Tightened with anchor cases: KEEP-IN-GENERAL examples (project risks, team capacity, timeline pressure, role assignments) and SENSITIVE examples (specific dollar overruns, named-person HR actions, embargoed agency reviews) now anchor the LLM against the same false-positives. |
| D29 | **Separate column: `status_sensitive_markdown`.** Sensitive content is stored in its own column, NOT in a section of `status_markdown`. **Why a column not a section:** (a) access enforcement is column-SELECT — code that reads `status_markdown` doesn't even know the sensitive column exists, so no risk of section-parser bugs leaking content; (b) audit rows partition naturally by `property` (`status_markdown` vs `status_sensitive_markdown`) and can have independent access controls on `*_changes` queries; (c) each blob is self-contained — independent `_edited_at_` header, independent merge passes. **Shape:** general blob is `_edited_at_` + `## At a glance` (code-rendered structured fields — always general by nature, since they're SQL truth) + `## Context` (general bullets, including LLM-derived insights from sensitive sources per D28). Sensitive blob is `_edited_at_` + `## Context` only — no at-a-glance, bullets-only. NULL when no sensitive content has ever landed (empty-doc avoidance). **Synthesis:** one LLM call produces both outputs — derivation needs to see sensitive content to write the general insight, so they're tightly coupled. Delimited two-section response (`=== GENERAL ===` / `=== SENSITIVE ===`); caller parses and assembles two docs. **Cursor:** `computeCursor` parses `edited_at` from BOTH columns and takes the max — so a scan that produces only sensitive content still advances the cursor. **Persistence:** persist functions write both columns; audit rows go to `*_changes` with the matching `property`. |

## Data model — diff against current schema

```
Campaign + Account (gcp-universal-backend/prisma/schema.prisma):
  + statusMarkdown String? @db.Text

drive_change_proposals (no column changes; new value for `kind`):
  kind = 'field_change'        ← existing
       | 'new_entity'          ← existing
       | 'additional_update'   ← NEW

  For kind='additional_update':
    property        = '__note__'           (sentinel)
    proposedValue   = { items: [{text, source_file_id, ...?}] }
    currentValue    = null
    proposalGroupId = NULL for existing-entity batches;
                      shared with new_entity rows for new-entity creation
    accountId / campaignId: exactly one set (the entity this batch is for)

campaign_changes / account_changes (no schema change):
  Synthesis writes one row per status_markdown update:
    property            = 'status_markdown'
    previous_value_text = old status_markdown (possibly null)
    value_text          = new status_markdown
    changed_by          = reviewer.id (per D14)

drive.schema.ts (mirrored — both copies; banner already exists):
  No additions to the writable allowlists (per D17).
  No changes to the FieldWriteSpec tables.
```

## End-to-end sequence

```
SCAN PHASE (gub-drive-sync Job, mode=run-full-sync or via poll dispatch)

  For each linked entity (campaign or account with drive_folder_id):
    traverseFolder + per-file extraction + per-file LLM interpretation
      → observations bucket (existing)
    distillAndEmit (existing) →
      field_change rows in drive_change_proposals
      notes / ambiguous in drive_scan_logs
    NEW: notes from distillation → ONE additional_update row in
         drive_change_proposals (kind='additional_update', items[] from notes)

  Discovery (new-entity candidates):
    Sample DISCOVERY_FILE_BUDGET=2 files (per D13)
    Run per-file LLM interpretation on those 2 files → observation bucket
    Run new-entity LLM pass → field guesses (existing)
    Write new_entity rows under a fresh proposalGroupId (existing)
    NEW: write ONE additional_update row sharing the same proposalGroupId,
         items[] from the observation bucket

NOTIFY (unchanged):
  Group pending+unnotified proposals by reviewer_staff_id, email magic link.

REVIEW PHASE (GUB drive.review.ts via gub-review UI)

  GET /review/:token:
    resolveReviewSession returns:
      - fieldChanges[]        (existing)
      - newEntityGroups[]     (existing) — each group's row list NOW
                                            includes its additional_update
                                            row's items[], rendered in
                                            the card's "Observations"
                                            section (per D12 + P)
      - additionalUpdates[]   NEW — standalone additional_update rows for
                                    existing entities; one card per row

  Reviewer edits + decides:
    For each card:
      field_change         → approve / reject (existing semantics)
      new_entity group     → approve / reject; field overrides;
                             NEW: also edits to attached observations
      additional_update    → approve / reject; NEW: edit + delete items

  POST /review/:token/decide → applyDecisions:
    Existing per-decision transactions apply structured changes + create
    new entities + flip proposal states (as today).

    NEW: After the decisions loop, build a set of entities touched by
    ≥1 approval (per D8). For each:
      Load current entity row (post-batch state)
      Load current status_markdown (possibly null)
      Build prompt inputs (per D9 / D11)
      Call Gemini with the hardcoded synthesis prompt (per D15)
      Receive new status_markdown
      In one transaction:
        UPDATE campaigns/accounts SET status_markdown = new
        INSERT campaign_changes/account_changes (
          property='status_markdown',
          previous_value_text=old, value_text=new,
          changed_by=reviewer.id
        )

  Response includes per-decision results (as today) + a summary of which
  entities had their status_markdown regenerated.

DISPLAY (any consumer: gub-admin, casting tool, etc.):
  Fetch campaign + account rows + status_markdown.
  Compose title + at-a-glance summary live from columns (per D3).
  Render stored status_markdown body below.
```

## Implementation phases

Numbered so they can be sequenced as PRs. Each phase ends with something
runnable.

### Phase 1 — Schema migration (in gcp-universal-backend)

- Migration: add `statusMarkdown String? @db.Text` to `Campaign` and `Account`.
- Update `gcp-universal-backend/prisma/schema.prisma`.
- Mirror schema into `gub-drive-sync/prisma/schema.prisma` (just `prisma generate`'d from the canonical copy).
- No code changes yet. Existing tests still pass.

### Phase 2 — Additional_update proposals from distillation (in gub-drive-sync)

- Extend `src/drive/distill.ts`:
  - When the distillation response has `notes[]`, write ONE additional_update row per scan per entity (instead of N drive_scan_logs).
  - Ambiguous items still go to drive_scan_logs (per earlier decision).
  - `proposedValue = { items: [{text, source_file_id}] }` — items derived from the notes array.
  - `property='__note__'`, `currentValue=null`.
- Unit test: distillation pass with notes produces the expected additional_update row shape.
- At this point: existing-entity flow generates additional_update rows; reviewer UI doesn't render them yet, so they sit in the DB.

### Phase 3 — Reviewer UI: additional_update card (in gub-review)

- `src/app/drive-review/[token]/types.ts`: add `additionalUpdates: AdditionalUpdate[]` to the session shape.
- `src/app/drive-review/[token]/review-client.tsx`: new `AdditionalUpdateCard` component. Renders the items as an editable list (edit + delete; no add per D6). Approve/reject at card level.
- Decision body extends: `{ proposalId, decision, overrideItems?: Array<{text, source_file_id?}> }`.
- `gcp-universal-backend/.../drive.review.ts`:
  - `resolveReviewSession` returns the new section.
  - `parseDecisionsBody` accepts `overrideItems` on single-decision rows.
  - `applySingleDecision` handles `kind='additional_update'`: on approve, stamp `proposalState='applied'` and overwrite `proposedValue.items` with the override list (so synthesis later reads the edited list). On reject, stamp 'rejected'.
- At this point: existing-entity additional_updates are reviewable end-to-end. No status_markdown yet — synthesis comes next.

### Phase 4 — Synthesis call + prompt constant (in gcp-universal-backend)

- `src/modules/integrations/google-drive/prompts/status-synthesis.v1.ts`: hardcoded prompt template + version constant.
- `src/modules/integrations/google-drive/drive.status-synthesis.ts`:
  - `synthesizeStatus({ entityType, entityId, reviewerStaffId, approvedItems[] })` → calls Gemini, returns new markdown.
  - Uses `runPreset`'s plumbing but with an in-line template, NOT a `prompt_presets` row.
  - Builds the "At a glance" bullet block from current field values (D2 + D11).
  - Asks Gemini for the Context section only.
  - Concatenates and returns. (Or asks for the full doc and validates the bullets match — TBD during implementation.)
- Pure function (no DB writes). Caller wires it up next phase.

### Phase 5 — Wire synthesis into applyDecisions

- `applyDecisions` in drive.review.ts gains a post-loop step:
  - Collect entities touched by ≥1 approved item.
  - For each, call synthesizeStatus.
  - In a transaction: UPDATE entity, INSERT *_changes row.
  - Log + return summary in response.
- Failure handling: synthesis failure for one entity doesn't abort others; logs the error; reviewer's decisions are still applied. Next sync triggers another synthesis attempt.
- End-to-end working at this point for existing entities. Reviewer approves something → status_markdown is populated/updated.

### Phase 6 — Debug script (in gub-drive-sync)

- `scripts/seed-status-proposal.ts`:
  - Args: `--campaign-id X` OR `--account-id Y`; `--items '<json>'` OR `--items-file <path>` (the proposed additional_update items); `--reviewer-staff-id <uuid>`.
  - Looks up the entity + reviewer, writes ONE additional_update row, prints the magic link.
  - Optional: `--also-field-changes <json>` to seed structured field changes in the same batch (so synthesis sees varied inputs).
- Iteration loop: tweak prompt source → run script → click link → approve → inspect new status_markdown in DB → repeat. (Per D16.)

### Phase 7 — New-entity flow (in gub-drive-sync + gub-review + gcp-universal-backend)

This is the meatier UI/logic phase but doesn't block earlier ones.

- `src/drive/discover.ts`:
  - Lower DISCOVERY_FILE_BUDGET to 2 (per D13).
  - After the new-entity LLM pass, run per-file interpretation on the sampled files → observation bucket.
  - Write ONE additional_update row sharing the new-entity proposalGroupId.
- `gub-review/src/app/drive-review/[token]/review-client.tsx`:
  - `NewEntityGroupCard` grows an "Observations" section showing the editable item list (same UI as the standalone additional_update card).
- `drive.review.ts: applyGroupDecision`:
  - On approve, find the attached additional_update row (same proposalGroupId).
  - Apply edited observations (if reviewer modified them).
  - In the same transaction that creates the new entity: also call synthesizeStatus and write the resulting status_markdown directly to the new row.
  - On reject: also flip the attached additional_update to 'rejected'.

### Phase 7.5 — Heal step + rescue-to-note (landed 2026-05-25)

Implementation status: live. See D18–D21.

- `src/drive/heal.ts` — auto-apply structured-field extraction from existing status_markdown. Runs FIRST in `scanEntity`. Idempotent. No proposals — direct writes with audit row + `changed_by = DRIVE_SYNC_SYSTEM_STAFF_ID`.
- `src/drive/distill.ts` — rescue-to-note: failed field_changes demote into the additional_update batch + write `category='diagnostic'` scan log.
- Migration `20260525100000_loosen_drive_proposal_check_and_seed_drive_sync_staff` — loosens CHECK + seeds system staff row.
- Migration `20260525110000_seed_drive_field_heal_prompt` — adds `drive.field_heal.v1` preset.

### Phase 8 — Prompt iteration

- Run the debug script across a representative set of campaigns and accounts.
- Tweak the synthesis prompt until the doc matches the goldilocks bar.
- Commit prompt versions; bump the version constant in source.
- No code changes needed beyond the prompt itself.

## Open items (decide during implementation)

- **Exact prompt text.** Will be iterated in Phase 8. Initial v1 lands in Phase 4.
- **At-a-glance bullet rendering:** code-generated outside the LLM, or asked from LLM with strict instructions? I'd start with "asked from LLM with strict prompt discipline and verbatim field values in the prompt"; if drift becomes a problem, swap to code-rendered. Easy to flip mid-implementation.
- **`drive_change_proposals.expires_at`** for additional_update rows: use the same `DRIVE_PROPOSAL_TTL_DAYS=14` as field changes? Probably yes.
- **`sweep-expired` interaction:** the existing sweeper flips `state=pending → expired` past `expires_at`. Works for additional_update too — no change.
- **Synthesis failure surfacing:** how does the reviewer know if their approvals went through but status_markdown failed to regenerate? Probably a banner on the post-decide response screen. Iterate during UI work.
- **Decision body migration:** the new `overrideItems` field is backward-compatible (no existing client sends it). No coordinated deploy needed.
- **drive.schema.ts mirroring:** no changes per D17, but worth a one-line note in the LOUD banner that status_markdown is intentionally NOT in the allowlist.

## Known temporary debt (no implementation now, captured for later)

- **Change-log bloat from markdown blobs.** Every status synthesis writes a full doc-before + doc-after into `campaign_changes` / `account_changes`. At scale: 20KB markdown × N entities × M syncs/year. Postgres TOAST compresses this well (~70% on prose), so we have runway. Future mitigations: monthly partitioning of *_changes tables with cold-storage / BigQuery export of older partitions; or storing `value_text_diff` (markdown patch) instead of full docs. Not now.
- **Source attribution.** v1 will likely have `[src: filename]` inline citations in the prose (debatable in prompt iteration). If they get noisy, we can drop them.
- **Status_markdown for the casting tool.** Out of scope here, but the whole point is downstream consumers like the casting tool can query `SELECT name, status_markdown FROM campaigns WHERE owner_staff_id=X` and get the human-readable summary in one shot. That's the canonical read path.

## What this does NOT change

- The existing field_change pipeline (allowlist, validators, FieldWriteSpec) is unchanged.
- The new_entity pipeline is unchanged except for the attached observations.
- The existing `notes`/`ambiguous` drive_scan_logs categories: `ambiguous` stays as a log; `notes` is what gets promoted into additional_update rows.
- The `prompt_presets` table and the existing three Drive prompts there.
- The Drive sync's chunking / reaper / self-trigger mechanics.

## What this does NOT do (deliberately, for v1)

- No prompt-editing UI in gub-admin (D15 — prompt is git-tracked).
- No per-item approve on additional_update (D6 — all or nothing on the batch).
- No "add new item" button on the additional_update card (D6).
- No reviewer preview of the resulting status_markdown before approval (the whole design point: status is a consequence, not a thing under review).
- No prior-status-version awareness in the synthesis prompt (D9 / β — just current state + this batch).
- No status_markdown for entities other than campaigns + accounts.

## Scaling model — mechanical chunking, LLM-as-reader

> Forward design, not v1 implementation. v1 ships single-file
> `status_markdown` per entity (D1). This section captures the planned
> response to accumulation, locked under D22 + D23.

Account and campaign complexity grows over time, both vertically
(state changes — captured in `*_changes` tables) and horizontally (new
topics and detail accumulate — that's what `status_markdown` carries).
Horizontal growth is real and unbounded; we need a model for it.

**The reader is an LLM, not a human.** This is the load-bearing
reframing. The doc exists to be ingested by an LLM that's generating
responses to a user query. Human reading attention isn't the constraint;
LLM context budget and synthesis cost are.

A single monolithic doc has a real cost under that lens: every read
pays for the whole doc. A narrow query ("what's the budget on Chevy?")
loads 20KB of unrelated context. At scale that's wasteful and slow.

### Chunking model (when we cross the threshold)

- **Mechanical, not topical.** Chunks have no semantic meaning. Each
  chunk is a bounded packet of durable state.
- **Chunk budget: ~6,000 tokens (≈ 500 lines of typical mixed
  bullet/prose status content).** The budget is denominated in tokens,
  not lines — a bullet line and a paragraph line differ ~3× in token
  cost. Reasoning behind 6K:
  - Per-chunk rewrite output stays in the 5–15s latency window for
    Gemini 2.5 Flash (D7's reviewer-blocking budget). Three parallel
    chunk rewrites also fit since latency = max-of-parallel.
  - Below ~2K tokens, fixed per-call overhead (auth, prompt warmup,
    network) dominates; an entity with 50KB of state would need 12+
    chunks for not much benefit.
  - Above ~10K tokens, output generation pushes 20–30s (busts D7),
    and rewrite coherence degrades — the LLM starts losing track of
    what it already emitted earlier in the same output.
  - Enforced as a soft cap measured at append time with a cheap
    char-based estimate (chars ÷ 4 ≈ tokens). Estimation error is
    fine because the cap is a target, not a hard limit.
- **File layout:** `status.md`, `status-2.md`, `status-3.md`, … One
  file per chunk.
- **Synthesis is a per-chunk rewrite pass.** For each chunk: chunk
  contents + candidate items → LLM → rewrites only chunks that change.
  Most chunks per scan won't change. Parallelizable across chunks
  since they're independent under the no-classification model.
- **Genuinely-new candidates tail-append.** Items that didn't land in
  any chunk during the rewrite pass go into the last chunk until
  adding the next item would push it past ~6K tokens, then spawn a new
  chunk. Side effect: chunks end up roughly chronological by *first
  introduction* of their content. That's fine — chunks aren't meant
  to be read linearly.
- **Read path:** an LLM agent answering a user query loads a slim
  index and pulls only the chunks it needs. Sequential "load chunk →
  check relevance → load next" is a useful access pattern that a
  monolithic doc can't support.

### What this model rules out (and why)

- **Topical or semantic chunking** ("Decisions" / "Risks" / "Open
  questions"). Hidden classification. Hard to maintain. Drifts. The
  point of mechanical chunking is to *not* make those calls.
- **Time-based prominence** (weight recent state heavier). Presumes
  important and durable state gets reiterated in fresh inputs. In
  practice an account person's biggest sin is losing track of a quiet
  client decision — exactly the failure mode this would create.
- **Append-only logs.** Degenerates into a chronological transcript.
  No consolidation. Solves nothing the *_changes tables don't already
  solve better.

### Transient state (D23)

Some content is important but time-bound. The synthesis prompt is
allowed to write items into a `## Transient` section with an explicit
`[expires: YYYY-MM-DD]` marker per line. Pre-synthesis step prunes
expired lines. Everything outside `## Transient` is durable.

This is the *only* semantic distinction we make — and only because
"someone said this thing is time-bound and tagged it" is qualitatively
different from "we guessed this thing was time-bound." The expiration
date is supplied content, not inferred.

### Trigger for implementing the chunking model

Wait for evidence. Likely signals:

- A synthesis call's total tokens (current doc + candidates + prompt)
  routinely exceeds ~50% of the model's context window, OR
- Synthesis latency on a busy entity makes the reviewer-blocking
  applyDecisions handler unreasonably slow (D7 budget is 5–15s).

When one of those hits, design the chunk-index format, the per-chunk
rewrite orchestration, and the prune-then-synthesize Transient
handling. Until then, single-file is correct.

## Parked / future considerations (not active design)

- **Media file handling (images, videos, audio, raw renders).** Today these are skipped with `unsupported_mime`. A future pass might add: image extraction via Gemini multimodal (free, current scope works), and a `__metadata__/<filename>.<ext>.md` sidecar convention for human-authored descriptions of media we can't reliably interpret (esp. video). The sidecar pattern could be read-only on our side (no Drive write scope) since the existing markdown extractor would pick the files up automatically. **Not actively planning** — Google may ship native functionality (e.g. Drive's own image/video understanding, or richer file-level metadata fields) that obviates the need to build this ourselves. Revisit when we have a concrete casting-tool need that today's text-only extraction doesn't meet.

- **Team-member contribution characterization (revision-content diffs).** The planned `drive_file_revisions` table captures per-revision metadata — who/when/where — which answers "who's been most active on the pitch deck" with a SQL group-by. A richer future signal would characterize *what kind of work* each editor contributes: fetch revision contents in pairs (revision N vs N-1), send to an LLM, get back labels like "Bob added the messaging hierarchy" / "Alice tightened the budget table" / "Carol fixed typos." Useful for casting questions like "who on the team writes brand-voice copy well?" that metadata can't answer. **Not actively planning** because:
  - Drive auto-saves a micro-revision every few keystrokes; you'd be characterizing autosaves unless you first solve a revision-collapsing problem (collapse by user + time window + content-change threshold). That's the actual hard work.
  - Sheets/Slides historical revision content is lossy via export (per the revisions.export quality note); LLM diffs compare degraded representations.
  - 2× LLM calls per characterized revision × N revisions × M files. Cost scales fast.
  - It's a research project — no clean acceptance criteria; "is the characterization useful enough" requires the system to exist before you can judge.
  - Marginal value over metadata is real (call it 1.3× not 5×) — strong rationale for not paying the cost until the metadata-only signal is genuinely insufficient.

  **Build trigger:** a concrete product question someone's asking that metadata can't answer (e.g., "we're staffing a Diageo pitch and want to know who writes brand-voice copy well"). Until then, metadata + interviews cover the use case. When/if built, natural shape is a separate offline pipeline reading `drive_file_revisions`, fetching paired revision contents, LLM-characterizing, writing to a new `drive_revision_characterizations` side table. Doesn't touch live sync code.

## Cross-references

- **Drive sync architecture** (current, post-extraction): `gub-drive-sync/README.md`
- **Mirrored schema banner** (already exists; will get a note added per D17): `gub-drive-sync/src/drive/schema.ts` + `gcp-universal-backend/src/modules/integrations/google-drive/drive.schema.ts`
- **Review flow today**: `gcp-universal-backend/src/modules/integrations/google-drive/drive.review.ts`
- **Reviewer UI today**: `gub-review/src/app/drive-review/[token]/review-client.tsx`
- **Discovery today**: `gub-drive-sync/src/drive/discover.ts`
- **Distillation today**: `gub-drive-sync/src/drive/distill.ts`
