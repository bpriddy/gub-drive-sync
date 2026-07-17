# The three-tier insight architecture

Campaigns, campaign pieces, and ideas. One reality, three kinds of truth about
it — operational state, execution detail, and creative memory — each with its
own identity rule and lifespan. This is the canonical statement of the model
(2026-07-17); the schema comments in `prisma/schema.prisma` and the module
headers in `src/drive/` implement it.

The connective doctrine across all three tiers: **LLM judgments are one-shot
ratchets into DB truth.** A judgment (campaign identity, a merge, a piece
mint, an idea match) lands once and is never re-litigated by later scans —
anchors, job numbers, and known-sets exist to make re-scans converge instead
of churn.

## Campaigns — the operational tier

A campaign is an **engagement**.

- **Identity = name + structural year.** Name matching is MEANING-based
  (LLM-judged: reused non-standard language, slogans, acronyms — never
  generic domain words, never string similarity). The year comes from the
  Drive FOLDER STRUCTURE (a 4-digit path segment; title years don't count).
  Same name + same structural year = same campaign; different years =
  different campaigns, always; unknown year never merges.
- **Born only from folders or merges — never from mentions.** A campaign
  named in a document that has no folder is account-level context (the
  brand's history or pipeline), not a new entity.
- **Holds the dossier**: `status_markdown` (+ the sensitive companion per
  D28/D29) — budget, objective, timeline, staffing, partners, asset
  locations. Maintained by merge + supersede-with-preserve; transient facts
  carry `[expires:]` and are pruned pre-synthesis. Structural columns
  (status, dates, budget) are HEALED from the dossier, not written directly.
- **Zone model** (see the extraction preset): inside a campaign's folder
  tree its identity is locked; the identity FAMILY includes its pieces'
  names, so a piece folder is never mistaken for a foreign campaign.
  Foreign-subject content inside a locked zone is misfiled human error —
  dropped, not quarantined.
- **Dedup** (merge-campaign-dupes): meaning-based clustering, year-gated;
  a merge collapses IDENTITY, never content — variant folders become pieces.

## Campaign pieces — the execution tier (campaign-scoped)

A piece is **a distinct thing the campaign actually produced or is
producing**: a commercial, a social series, a merch/collectible line, a tool,
an activation. Not a discipline, not a workstream, not an unproduced concept.

- **Identity = job number, when one exists — hard and authoritative.**
  Agency bracket codes on project folders (`[GMCHV55000216]`) are
  billing-grade identity: same number = same piece always; different numbers
  = different pieces always; job-number matching OUTRANKS all name/meaning
  matching. Name identity is the fallback for content-born pieces until a
  number surfaces. The campaign folder's own bracket code denotes its ANCHOR
  job — usually the namesake deliverable.
- **Three birth paths:**
  1. **Content-born (primary)** — `derive-pieces` reads the campaign dossier
     and mints identified executions. Money and delivery paperwork ARE
     execution evidence (budget allocations, POs, signed estimates,
     production-partner awards, scripts/storyboards, ATA/broadcast
     paperwork) — the anchor deliverable often has no name of its own
     because it goes by the campaign's name.
  2. **Merge-born** — a variant folder judged to be the same campaign
     becomes a piece of the canonical, carrying its folder's job number.
  3. **Folder enrichment** — files under a piece's folder bucket to the
     piece during scans (`file.pieceId` / piece-anchor overlay).
- **Own fine-detail markdown**; high-level facts ABSORB UP into the campaign
  dossier (with a dedupe guard against double-landing).
- **Anti-resplit anchors**: once a folder is a piece, no later scan can
  re-split it into a campaign. One-way door.

## Ideas — the memory tier (org-level)

An idea is **one discrete creative concept that was pitched**. Never the
campaign's platform, approach, or creative strategy — an umbrella that keeps
absorbing everything has stopped being an idea; the platform IS the campaign.

- **Deliberately decoupled**: ideas reference account / campaign / piece by
  EXTERNAL id (Drive folder ids / plain text), no foreign keys — the memory
  tier survives every operational event (merges, renames, restructures).
- **Shape**: `facets` — right-sized natural-language rows that together ARE
  the idea's description — plus `idea_changes`, an append-only
  add-and-overwrite provenance log.
- **Sourcing**: deck-gated (pitch / creative_review only; the per-file
  extractor classifies `deck_type` as a byproduct). Precision over recall —
  a wrong idea pollutes the memory.
- **Merging**: match is same-underlying-concept (renames and refinement
  rounds of one concept ARE the same idea; distinct concepts sharing a
  campaign/theme/season are NOT; concept-vs-umbrella is NEVER a match).
  Merges **COMPOSE FRESH** — the fewest right-sized rows carrying all
  distinct, current meaning; an outcome row REPLACES its proposal row.
  ("Merge these sets" anchors a model on copying; "compose fresh from raw
  material" makes compression the default — measured: a 74-facet umbrella
  recomposes to ~20 with meaning retained.)
- **Self-containment (ruled 2026-07-17)**: the idea's FULL arc — pitched →
  refined → won → became → performed — lives inside the idea. The
  award-freeze alternative (stop accumulating at award, point at the piece)
  was considered and REJECTED: it breaks self-containment by making memory
  depend on mutable operational rows. Compression, not truncation, keeps
  ideas readable.
- **In-scan ordering**: idea extraction is parallel-safe; match/merge/persist
  is a strictly serial, file-ordered consumer (the ratchet's chronology must
  be deterministic — see the scan-parallelism doctrine).

## Future scope of ideas

**Planned / half-built:**

1. **The award link** — `ideas.pieceId` + the admin "awarded" badge exist;
   nothing sets the link yet. Mechanism: when derive-pieces mints/matches an
   execution, ask which known idea it realizes. Completes the
   pitched→produced lineage and enables "which of our ideas actually get
   bought" analysis.
2. **The retrieval surface — APPROVED ACTIVE PLAN** (the Piece/Idea
   Distribution Plan): expose campaign_pieces (campaign-inherited access)
   and ideas (table-level `idea_all` grant, all-or-nothing) through GUB's
   read API → thin gub-agent tools → gchat-bot end-to-end. The tier exists
   to answer "have we already pitched something like this?" — concept-
   similarity search matters most here, since ideas are the entity where
   MEANING matching is the whole point.

**Discussed, deliberately deferred (candidates, not commitments):**

3. Lifecycle facets (explicit pitched/awarded/produced stage rows) — passed
   over in favor of the minimal supersede fix.
4. A merge-depth alarm — flag (never block) an idea whose merge count hits
   double digits as a split-review candidate.
5. Cross-account concept search ("didn't we pitch this for another
   client?") — needs a confidentiality ruling first (client A's unsold
   concept surfacing in client B's context).
