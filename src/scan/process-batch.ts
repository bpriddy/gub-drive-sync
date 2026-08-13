// Part of the backfill engine (see index.ts). Extracted verbatim from the
// former scripts/backfill.ts monolith — behavior-preserving reorganization.
import { prisma } from '../prisma';
import { driveClient } from '../drive/client';
import { extractText } from '../drive/extract';
import { interpretAssetFolder } from '../drive/asset-folder';
import {
  interpretFile,
  type AccountObservation,
  type CampaignObservation,
  type InterpretFileOutput,
} from '../drive/interpret';
import {
  ACCOUNT_FIELD_WRITE,
  CAMPAIGN_FIELD_WRITE,
  buildCampaignCurrentState,
  isNoOpChange,
  validateProposedValue,
  type AccountCurrentState,
  type CampaignCurrentState,
  type FieldWriteSpec,
} from '../drive/schema';
import { summarizeError } from '../progress';
import { defaultLlm } from '../ai';
import {
  accountFieldsAsMap,
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
} from '../drive/status-synthesis';
import type { Attributor, EntityAttribution } from '../drive/structure';
import {
  createIdeaScanContext,
  extractIdeaCandidates,
  mergeIdeaCandidates,
} from '../drive/idea-scan';
import type { ExtractedIdea } from '../drive/idea-extraction';
import type { TraversedFile } from '../drive/types';
import { config } from '../config';
import { log, fmtBytes, fmtMs } from './output';
import { timed } from './timing';
import { runWithConcurrency } from './util';
import { isForeignCampaignTag, routeCampaignObs, isDrivePermissionError, EMPTY_CAMPAIGN_STATE } from './routing';
import {
  runDryRunDistillation,
  persistTarget,
  type ValidatedChange,
} from './persist';
import type { EntityCtx } from '../backfill/entity';
import type {
  BatchOutcome,
  CampaignBucket,
  CampaignNameDirectory,
  EntitySynthesisResult,
} from './batch-types';

export async function processBatch(
  batch: TraversedFile[],
  ctx: EntityCtx,
  attributor: Attributor | null,
  /**
   * Directory for subject-based campaign routing. Null when attributor
   * is null (campaign-scoped scan — no cross-campaign attribution).
   * Carries (a) the verbatim known campaign names passed to the per-
   * file LLM as the entity_campaign_name vocabulary, and (b) the
   * lookup tables used to resolve a matched name back to its bucket
   * key (existing campaignId or structure-discovered folderId).
   */
  nameDirectory: CampaignNameDirectory | null,
  /**
   * FolderNode.path by folder id (deterministic breadcrumb), from the
   * structure walk. Null when attributor is null. Used to stamp
   * campaign.drive_folder_path on newly created campaigns.
   */
  folderPathById: Map<string, string> | null,
  /**
   * Pieces of the SCANNED campaign (campaign-scoped runs only; null for
   * account scans). Used by regime-1 routing to bucket piece-tagged files
   * (file.pieceId, set at discovery) to their piece.
   */
  piecesById: Map<string, { name: string; driveFolderId: string }> | null,
  /**
   * Identity family per existing campaign (campaign name + its pieces'
   * names). Account scans use it to (a) lock campaign-zone files to their
   * family and (b) hand the family to the per-file call as the vocabulary.
   */
  familyByCampaignId: Map<string, string[]> | null,
  applyToDb: boolean,
  /**
   * The "as-of" date for this scan in YYYY-MM-DD form. Used to stamp the
   * synthesized status_markdown's edited_at header. For backfill this is
   * the day being processed (the file bucket's calendar day); for any
   * future forward-sync callers it'd be today's date.
   */
  editedAt: string,
  /**
   * Per-file worker count WITHIN this one batch (= one day). See the
   * scan-parallelism doctrine at the pool below: days never overlap.
   */
  concurrency: number,
): Promise<BatchOutcome> {
  log(`  Extracting + interpreting ${batch.length} file(s)…`);

  const accountBucket: Array<{ observation: AccountObservation; sourceFileId: string }> = [];
  // Per-campaign buckets, keyed by a synthetic bucket key:
  //   - "existing:<campaignId>"   — tag-routed OR folder-routed to a known existing campaign
  //   - "new:<folderId>"          — structure-discovered new candidate (folder-based)
  //   - "phantom:<normalizedName>" — LLM emitted entity_campaign_name with no name match
  // Only populated when attributor is non-null (account scan).
  const campaignBuckets = new Map<string, CampaignBucket>();
  // Legacy single campaign bucket — used when attributor is null (campaign
  // scans, or if structure hasn't been resolved for any reason).
  const legacyCampaignBucket: Array<{ observation: CampaignObservation; sourceFileId: string }> = [];
  // Per-piece buckets — files under a piece's folder bucket to the PIECE
  // (fine detail); their high-level rolls up to the owning campaign at
  // synthesis time (absorb-up). Keyed by pieceId. Populated in account scans
  // via attribution.pieceId (piece-anchor overlay) and in campaign scans via
  // file.pieceId (tagged at discovery when gathering piece folders).
  interface PieceBucket {
    pieceId: string;
    pieceName: string;
    campaignId: string;
    campaignName: string;
    pieceFolderId: string;
    observations: Array<{ observation: CampaignObservation; sourceFileId: string }>;
    fileIds: Set<string>;
  }
  const pieceBuckets = new Map<string, PieceBucket>();

  // Ideas tier — per-scan context (lazy known-set cache). Only files the
  // per-file extractor classified pitch/creative_review fire the focused
  // idea call, so cost scales with decks, not with files. Requires the
  // account root folder id (the org-scope key on idea rows).
  const ideaCtx = ctx.accountFolderId
    ? createIdeaScanContext({
        accountExternalId: ctx.accountFolderId,
        accountName: ctx.accountName,
        apply: applyToDb,
      })
    : null;

  // The scanned campaign's identity family: its own name + its pieces'
  // names. A subject tag matching ANY of these is ours — two folders, one
  // campaign (BHAC's piece folder must never be treated as foreign).
  const ownIdentityNames: string[] =
    ctx.type === 'campaign'
      ? [ctx.name, ...(piecesById ? Array.from(piecesById.values()).map((p) => p.name) : [])]
      : [ctx.name];

  // ── Restricted-file re-probe ─────────────────────────────────────────────
  // A sharing fix does NOT bump modifiedTime, so delta gating would never
  // retry a restricted file on its own. Append every still-'restricted'
  // worklist row for this entity to the batch (skipping ids already
  // present) — the normal worker probes it: still 403 → lastProbedAt
  // advances; readable → the content flows through the full pipeline and
  // the row resolves. 'ignored' rows (human action in gub-admin) are never
  // probed. Cost: one Drive call per still-restricted file per scan.
  const probeCandidates = await prisma.driveRestrictedFile.findMany({
    where: {
      accountId: ctx.accountId,
      status: 'restricted',
      ...(ctx.type === 'campaign' ? { campaignId: ctx.id } : {}),
    },
  });
  const probedFileIds = new Set<string>();
  if (probeCandidates.length > 0) {
    log(`  Re-probing ${probeCandidates.length} restricted file(s)…`);
    const inBatch = new Set(batch.map((b) => b.id));
    const drive = await driveClient();
    for (const r of probeCandidates) {
      probedFileIds.add(r.fileId);
      if (inBatch.has(r.fileId)) continue;
      // Fresh metadata fetch: shortcuts need shortcutDetails (targetId +
      // targetMimeType) for extractText to follow them — the worklist row
      // doesn't carry that, and it can change (someone may replace the
      // shortcut's target). Metadata access can itself 403 on some
      // restricted shapes — treat that as "still restricted".
      let meta: {
        name?: string | null;
        mimeType?: string | null;
        parents?: string[] | null;
        size?: string | null;
        shortcutDetails?: { targetId?: string | null; targetMimeType?: string | null } | null;
      };
      try {
        const res = await drive.files.get({
          fileId: r.fileId,
          fields: 'id,name,mimeType,parents,size,shortcutDetails(targetId,targetMimeType)',
          supportsAllDrives: true,
        });
        meta = res.data;
      } catch (err) {
        if (isDrivePermissionError(err)) {
          batch.push({
            id: r.fileId,
            name: r.name,
            mimeType: r.mimeType ?? 'application/octet-stream',
            parents: r.parentFolderId ? [r.parentFolderId] : [],
            path: r.path ?? r.name,
            modifiedTime: null,
            modifiedByEmail: null,
            createdTime: null,
            size: null,
            isFolder: false,
          });
          continue;
        }
        log(`  ⚠ re-probe metadata fetch failed for "${r.name}": ${summarizeError(err)}`);
        continue;
      }
      batch.push({
        id: r.fileId,
        name: meta.name ?? r.name,
        mimeType: meta.mimeType ?? r.mimeType ?? 'application/octet-stream',
        parents: meta.parents ?? (r.parentFolderId ? [r.parentFolderId] : []),
        path: r.path ?? r.name,
        modifiedTime: null,
        modifiedByEmail: null,
        createdTime: null,
        size: meta.size ? Number(meta.size) : null,
        isFolder: false,
        ...(meta.shortcutDetails?.targetId && meta.shortcutDetails?.targetMimeType
          ? {
              shortcutTarget: {
                id: meta.shortcutDetails.targetId,
                mimeType: meta.shortcutDetails.targetMimeType,
              },
            }
          : {}),
      });
    }
  }

  let filesExtracted = 0;
  let filesSkipped = 0;
  let filesErrored = 0;
  /** Files visible in listings but 403 on content export → worklist rows. */
  let filesRestricted = 0;
  /** Previously restricted files that became readable this scan (rows resolved). */
  let filesRestored = 0;
  let filesZeroObs = 0;
  let accountLevelFiles = 0;
  let campaignObsDiscarded = 0;
  /** Obs about a DIFFERENT campaign found inside a campaign zone — misfiled content, dropped. */
  let foreignObsDropped = 0;
  /** Account-zone obs naming an UNKNOWN campaign → converted to account observations (no phantoms). */
  let unknownCampaignToAccount = 0;
  /** Tagged campaign obs whose name fuzzy-matched (Levenshtein) to a known campaign — logged for visibility. */
  let fuzzyMatchedObs = 0;

  // Binaries-only folders: when EVERY file in a folder skips extraction on
  // mime (fonts, images, video), the per-file prompt never sees the folder
  // — but path + file names are still evidence ("Fonts/Louis-Bold.ttf"
  // establishes the typeface). Collect unsupported-mime skips per parent
  // folder during the loop; folders that also produced readable text are
  // excluded afterwards (their extractable files already carry the
  // location context).
  const parentPathOf = (f: { path: string }): string => {
    const i = f.path.lastIndexOf(' / ');
    return i > 0 ? f.path.slice(0, i) : f.path;
  };
  const binaryOnlyFolders = new Map<
    string,
    { folderPath: string; fileNames: string[]; firstFileId: string; attribution: EntityAttribution }
  >();
  const foldersWithText = new Set<string>();

  /**
   * Route a synthetic (non-LLM-tagged) observation by folder attribution:
   * campaign zone → that campaign's bucket (legacy bucket on campaign
   * scans), account zone → the account bucket. Used by the asset-folder
   * pass and restricted-file sightings — deterministic routing, no tags.
   */
  function pushRoutedObs(
    obs: { text: string; reasoning: string; confidence: number },
    sourceFileId: string,
    attribution: EntityAttribution,
  ): void {
    if (attribution.ownerType !== 'campaign') {
      accountBucket.push({ observation: obs, sourceFileId });
      return;
    }
    if (!attributor) {
      legacyCampaignBucket.push({ observation: obs, sourceFileId });
      return;
    }
    const bucketKey =
      attribution.campaignStatus === 'existing' && attribution.matchedCampaignId
        ? `existing:${attribution.matchedCampaignId}`
        : `new:${attribution.campaignFolderId}`;
    let bucket = campaignBuckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        campaignName: attribution.campaignName ?? '(unnamed campaign)',
        campaignFolderId: attribution.campaignFolderId,
        campaignStatus: attribution.campaignStatus ?? 'new',
        matchedCampaignId: attribution.matchedCampaignId,
        bucketSource: 'folder',
        observations: [],
        fileIds: new Set(),
      };
      campaignBuckets.set(bucketKey, bucket);
    }
    bucket.observations.push({ observation: obs, sourceFileId });
    bucket.fileIds.add(sourceFileId);
  }

  // ── Within-day parallel pool ────────────────────────────────────────────
  // PARALLELISM IS SCOPED TO THIS ONE BATCH (= one day). Days are a serial
  // read-modify-write chain over entity state — distillation reads what the
  // previous day's synthesis wrote, and supersede order IS day order — so
  // days must never overlap (scan-parallelism doctrine, locked 2026-07-15).
  //
  // Split of responsibilities:
  //   runFileWorker (parallel): the expensive independent I/O — extract →
  //     interpret → deck-gated idea EXTRACTION. Touches no shared state.
  //   applyOutcome (serial, strict file-index order): everything that
  //     mutates shared state — bucket routing, counters, logging, and the
  //     idea match/merge ratchet. Because application is index-ordered, a
  //     parallel run hands distillation byte-identical buckets to a serial
  //     run, and the ideas ratchet keeps its deterministic chronology.

  interface WorkerOutcome {
    file: TraversedFile;
    attribution: EntityAttribution;
    kind: 'skip' | 'error' | 'restricted' | 'ok';
    skipReason?: string;
    skipDetail?: string;
    error?: unknown;
    extractor?: string;
    textLength?: number;
    res?: InterpretFileOutput;
    /** Deck-gated candidates from the worker; null = not a deck (or no idea
     *  context); 'failed' = extraction errored (already counted). */
    ideaCandidates?: ExtractedIdea[] | 'failed' | null;
  }

  // Resolve attribution from the file's immediate parent folder.
  // Without structure (attributor=null), every file is attributed to the
  // scanned entity itself — preserves the legacy campaign-scan behavior.
  function resolveAttribution(file: TraversedFile): EntityAttribution {
    if (attributor) return attributor(file.parents?.[0] ?? null);
    return {
      ownerType: ctx.type,
      campaignFolderId: ctx.type === 'campaign' ? ctx.folderId : null,
      campaignName: ctx.campaignName,
      matchedCampaignId: null,
      campaignStatus: ctx.type === 'campaign' ? 'existing' : null,
      pieceId: null,
      pieceName: null,
      pieceFolderId: null,
    };
  }

  async function runFileWorker(file: TraversedFile): Promise<WorkerOutcome> {
    const attribution = resolveAttribution(file);
    try {
      const extraction = await timed('extract_text', () => extractText(file));
      if (extraction.kind !== 'ok') {
        return {
          file,
          attribution,
          kind: 'skip',
          skipReason: extraction.reason,
          ...(extraction.detail ? { skipDetail: extraction.detail } : {}),
        };
      }

      // The per-file LLM gets the campaign context that owns THIS file (or
      // null for account-level files). This is the structural fix for the
      // attribution leakage — every campaign observation is now framed
      // against the right campaign name.
      const perFileCampaignName =
        attribution.ownerType === 'campaign' ? attribution.campaignName : null;

      const interpretVocabulary: string[] = nameDirectory
        ? attribution.ownerType === 'campaign'
          ? ((attribution.matchedCampaignId
              ? familyByCampaignId?.get(attribution.matchedCampaignId)
              : undefined) ?? (attribution.campaignName ? [attribution.campaignName] : []))
          : nameDirectory.knownCampaignNames
        : ctx.type === 'campaign'
          ? ownIdentityNames
          : [];

      const res = await timed('interpret_file', () =>
        interpretFile({
          file,
          text: extraction.text,
          accountName: ctx.accountName,
          accountCurrentState: ctx.accountState,
          campaignName: perFileCampaignName,
          campaignCurrentState: attribution.ownerType === 'campaign' ? ctx.campaignState : null,
          // Zone-conditional vocabulary: campaign-zone files get their
          // campaign's identity family (this-campaign/piece tags come back
          // verbatim; foreign subjects are dropped at source or by the
          // family check). Account-zone files get the full known roster —
          // the addressing directory is welcome only there.
          knownCampaigns: interpretVocabulary,
        }),
      );

      // Deck-gated idea EXTRACTION runs here (a pure LLM call over text the
      // worker already holds — parallel-safe). The order-sensitive
      // match/merge half runs in applyOutcome.
      let ideaCandidates: ExtractedIdea[] | 'failed' | null = null;
      if (ideaCtx && res.deckType !== 'other') {
        ideaCandidates = await timed('idea_extract', () =>
          extractIdeaCandidates(ideaCtx, { file, text: extraction.text, deckType: res.deckType }),
        );
      }

      return {
        file,
        attribution,
        kind: 'ok',
        extractor: extraction.extractor,
        textLength: extraction.text.length,
        res,
        ideaCandidates,
      };
    } catch (err) {
      if (isDrivePermissionError(err)) {
        return { file, attribution, kind: 'restricted' };
      }
      return { file, attribution, kind: 'error', error: err };
    }
  }

  async function applyOutcome(o: WorkerOutcome): Promise<void> {
    const { file, attribution } = o;

    if (o.kind === 'skip') {
      const detail = o.skipDetail ? ` (${o.skipDetail})` : '';
      log(`    ⊘ ${file.name}  [${file.mimeType}]  skip: ${o.skipReason}${detail}`);
      filesSkipped++;
      if (o.skipReason === 'unsupported_mime') {
        const folderKey = file.parents?.[0] ?? parentPathOf(file);
        const rec = binaryOnlyFolders.get(folderKey);
        if (rec) {
          rec.fileNames.push(file.name);
        } else {
          binaryOnlyFolders.set(folderKey, {
            folderPath: parentPathOf(file),
            fileNames: [file.name],
            firstFileId: file.id,
            attribution,
          });
        }
      }
      // A probed file that skips on 'empty' had its content READ (the
      // extractor ran and found no text) — readable again, resolve the row.
      // Metadata-only skips (unsupported_mime, shortcut_unverified_size,
      // oversized) prove nothing about content access: leave the row
      // restricted — probing is cheap and the operator can Ignore it.
      if (o.skipReason === 'empty' && probedFileIds.has(file.id)) {
        filesRestored++;
        log(`      🔓 previously restricted — now reachable (no extractable text); worklist row resolved`);
        if (applyToDb) {
          // Guarded like the main body's writes: a transient DB error on
          // one worklist row must not reject applyChain and discard the
          // whole day's extraction+LLM spend.
          try {
            await prisma.driveRestrictedFile.updateMany({
              where: { accountId: ctx.accountId, fileId: file.id },
              data: { status: 'resolved', resolvedAt: new Date(), lastProbedAt: new Date() },
            });
          } catch (err) {
            filesErrored++;
            log(`      ✗ worklist resolve failed: ${summarizeError(err)}`);
          }
        }
      }
      return;
    }
    if (o.kind === 'restricted') {
      log(`    ⛔ ${file.name}  RESTRICTED (403 — visible in listings, content not readable)`);
      filesRestricted++;
      if (applyToDb) {
        try {
          const existing = await prisma.driveRestrictedFile.findUnique({
            where: { accountId_fileId: { accountId: ctx.accountId, fileId: file.id } },
          });
          if (existing) {
            await prisma.driveRestrictedFile.update({
              where: { id: existing.id },
              data: { lastProbedAt: new Date() },
            });
          } else {
            await prisma.driveRestrictedFile.create({
              data: {
                accountId: ctx.accountId,
                campaignId:
                  attribution.matchedCampaignId ?? (ctx.type === 'campaign' ? ctx.id : null),
                fileId: file.id,
                name: file.name,
                path: file.path,
                mimeType: file.mimeType,
                parentFolderId: file.parents?.[0] ?? null,
              },
            });
            // First sighting: the dossier should KNOW the file exists — a
            // hole you can see beats one you can't (restriction correlates
            // with value: briefs, budgets, recaps).
            pushRoutedObs(
              {
                text: `A file named "${file.name}" exists at ${file.path} but its content is access-restricted — the sync bot cannot read it.`,
                reasoning:
                  'Drive returned 403 for content export; the file is visible in folder listings only.',
                confidence: 1,
              },
              file.id,
              attribution,
            );
          }
        } catch (err) {
          filesErrored++;
          log(`      ✗ restricted-worklist write failed: ${summarizeError(err)}`);
        }
      }
      return;
    }
    if (o.kind === 'error') {
      log(`    ✗ ${file.name}  ERROR: ${summarizeError(o.error)}`);
      filesErrored++;
      return;
    }
    foldersWithText.add(file.parents?.[0] ?? parentPathOf(file));
    const res = o.res!;

    try {
      const totalObs = res.account.length + res.campaign.length;
      const symbol = totalObs > 0 ? '✓' : '○';
      const attrLabel =
        attribution.ownerType === 'campaign'
          ? `→ "${attribution.campaignName ?? '(unnamed)'}"${attribution.campaignStatus === 'new' ? ' [NEW candidate]' : ''}`
          : '→ account-level';
      log(
        `    ${symbol} ${file.name}  [${o.extractor}, ${fmtBytes(o.textLength ?? 0)}]  ${attrLabel}  → ${res.account.length} account + ${res.campaign.length} campaign obs  [${res.driver}]`,
      );
      if (totalObs === 0) filesZeroObs++;

      // Account obs always go to the account bucket regardless of where
      // the file lives — they describe the brand at large.
      for (const obs of res.account) {
        accountBucket.push({ observation: obs, sourceFileId: file.id });
      }

      // Campaign obs routing. Three regimes:
      //
      // (1) No attributor → campaign scan, single-entity scope. Everything
      //     goes into the legacy bucket — tag is ignored (the LLM is
      //     extracting against one campaign anyway).
      //
      // (2) Attributor + tag (entity_campaign_name set) → SUBJECT-BASED.
      //     Match the tag against the known-campaign vocabulary. On match,
      //     route to that bucket regardless of which folder the file lives
      //     in. On no match, open a phantom bucket keyed by normalized name
      //     — becomes a folder-less new-candidate Campaign on persist.
      //
      // (3) Attributor + no tag → FALLBACK to file-folder attribution. Files
      //     in campaign folders nest under that campaign. Account-level
      //     files have no owner; campaign obs are discarded (counted).
      if (!attributor) {
        // Regime 1 — campaign scans write ONLY this campaign (+ account).
        // A foreign-subject obs is misfiled content (human error): drop +
        // count, never absorb. Piece-tagged files bucket to the piece; the
        // rest to the campaign.
        for (const obs of res.campaign) {
          if (isForeignCampaignTag(obs.entity_campaign_name ?? '', ownIdentityNames)) {
            foreignObsDropped += 1;
            log(`      ⊘ foreign-campaign obs dropped ("${(obs.entity_campaign_name ?? '').slice(0, 60)}")`);
            continue;
          }
          if (file.pieceId && !piecesById?.has(file.pieceId)) {
            // Cached piece tag no longer matches a piece of THIS campaign
            // (piece re-owned/deleted mid-chain). No wrong writes: drop the
            // obs rather than synthesize foreign content into the scanned
            // campaign. The piece's new owner picks it up on its own scan.
            campaignObsDiscarded += 1;
            continue;
          }
          if (file.pieceId && piecesById?.has(file.pieceId)) {
            const info = piecesById.get(file.pieceId)!;
            let pb = pieceBuckets.get(file.pieceId);
            if (!pb) {
              pb = {
                pieceId: file.pieceId,
                pieceName: info.name,
                campaignId: ctx.id,
                campaignName: ctx.name,
                pieceFolderId: info.driveFolderId,
                observations: [],
                fileIds: new Set(),
              };
              pieceBuckets.set(file.pieceId, pb);
            }
            pb.observations.push({ observation: obs, sourceFileId: file.id });
            pb.fileIds.add(file.id);
            continue;
          }
          legacyCampaignBucket.push({ observation: obs, sourceFileId: file.id });
        }
      } else {
        for (const obs of res.campaign) {
          // ── ZONE MODEL ──────────────────────────────────────────────
          // CAMPAIGN ZONE: at/below a campaign root the campaign is LOCKED.
          // Observations belong to that campaign's identity family (the
          // campaign, its pieces) or roll up to the account — content never
          // re-routes them. A foreign subject is misfiled content: drop.
          if (attribution.ownerType === 'campaign') {
            const family =
              (attribution.matchedCampaignId
                ? familyByCampaignId?.get(attribution.matchedCampaignId)
                : undefined) ?? (attribution.campaignName ? [attribution.campaignName] : []);
            if (isForeignCampaignTag(obs.entity_campaign_name ?? '', family)) {
              foreignObsDropped += 1;
              log(`      ⊘ foreign-campaign obs dropped ("${(obs.entity_campaign_name ?? '').slice(0, 60)}")`);
              continue;
            }
            if (attribution.pieceId && attribution.matchedCampaignId) {
              let pb = pieceBuckets.get(attribution.pieceId);
              if (!pb) {
                pb = {
                  pieceId: attribution.pieceId,
                  pieceName: attribution.pieceName ?? '(unnamed piece)',
                  campaignId: attribution.matchedCampaignId,
                  campaignName: attribution.campaignName ?? '(unnamed)',
                  pieceFolderId: attribution.pieceFolderId!,
                  observations: [],
                  fileIds: new Set(),
                };
                pieceBuckets.set(attribution.pieceId, pb);
              }
              pb.observations.push({ observation: obs, sourceFileId: file.id });
              pb.fileIds.add(file.id);
              continue;
            }
            const key =
              attribution.campaignStatus === 'existing' && attribution.matchedCampaignId
                ? `existing:${attribution.matchedCampaignId}`
                : `new:${attribution.campaignFolderId}`;
            let bucket = campaignBuckets.get(key);
            if (!bucket) {
              bucket = {
                campaignName: attribution.campaignName ?? '(unnamed campaign)',
                campaignFolderId: attribution.campaignFolderId,
                campaignStatus: attribution.campaignStatus ?? 'new',
                matchedCampaignId: attribution.matchedCampaignId,
                bucketSource: 'folder',
                observations: [],
                fileIds: new Set(),
              };
              campaignBuckets.set(key, bucket);
            }
            bucket.observations.push({ observation: obs, sourceFileId: file.id });
            bucket.fileIds.add(file.id);
            continue;
          }

          // ACCOUNT ZONE: above the campaign roots we scan at account level
          // AND known-campaign level — this is where the known-campaign list
          // is welcome. A tag matching a KNOWN campaign is addressed to it.
          // A named-but-UNKNOWN campaign becomes an ACCOUNT observation
          // (brand pipeline/history) — campaigns are born from folders or
          // merges, never from stray mentions (no phantoms).
          const routed = routeCampaignObs(obs, attribution, nameDirectory);
          if (routed.kind === 'discard') {
            campaignObsDiscarded += 1;
            continue;
          }
          if (routed.kind === 'phantom') {
            unknownCampaignToAccount += 1;
            accountBucket.push({ observation: obs, sourceFileId: file.id });
            continue;
          }
          if (routed.kind === 'matched' && routed.via === 'levenshtein') {
            fuzzyMatchedObs += 1;
            log(
              `      ↺ fuzzy match: "${obs.entity_campaign_name ?? '?'}" → "${routed.bucket.campaignName}" (sim ${routed.similarity.toFixed(2)})`,
            );
          }
          let bucket = campaignBuckets.get(routed.key);
          if (!bucket) {
            bucket = routed.bucket;
            campaignBuckets.set(routed.key, bucket);
          }
          bucket.observations.push({ observation: obs, sourceFileId: file.id });
          bucket.fileIds.add(file.id);
        }
        // Track account-level files for the summary (even if their obs
        // weren't discarded thanks to tag-routing).
        if (attribution.ownerType !== 'campaign') accountLevelFiles += 1;
      }

      // Ideas tier — the ordered half of the ratchet. Candidates were
      // extracted in the worker; match/merge/persist happens HERE, serially
      // and in file order (concurrent merges would double-create or
      // interleave the add-and-overwrite log).
      if (ideaCtx && Array.isArray(o.ideaCandidates) && o.ideaCandidates.length > 0) {
        const ideas = o.ideaCandidates;
        const ideaCampaignExternalId =
          attribution.ownerType === 'campaign'
            ? ctx.type === 'campaign'
              ? ctx.folderId // owning campaign root (covers piece-tagged files)
              : attribution.campaignFolderId
            : null;
        log(`      ◆ ${res.deckType} deck — merging ${ideas.length} idea(s)…`);
        await timed('idea_merge', () =>
          mergeIdeaCandidates(ideaCtx, {
            file,
            campaignExternalId: ideaCampaignExternalId,
            ideas,
          }),
        );
      }

      // A probed file that fully extracted is restored — resolve its
      // worklist row; its observations just flowed through the normal
      // pipeline above.
      if (probedFileIds.has(file.id)) {
        filesRestored++;
        log(`      🔓 previously restricted — now readable; worklist row resolved`);
        if (applyToDb) {
          await prisma.driveRestrictedFile.updateMany({
            where: { accountId: ctx.accountId, fileId: file.id },
            data: { status: 'resolved', resolvedAt: new Date(), lastProbedAt: new Date() },
          });
        }
      }

      filesExtracted++;
    } catch (err) {
      log(`    ✗ ${file.name}  ERROR: ${summarizeError(err)}`);
      filesErrored++;
    }
  }

  // Pool driver: N workers pull files by index; results are applied
  // strictly in file-index order through a serialized promise chain, so
  // every shared-state mutation happens in the same order as a serial run.
  if (concurrency > 1 && batch.length > 1) {
    log(`  (pool: ${Math.min(concurrency, batch.length)} workers within this day's batch — days stay serial)`);
  }
  const outcomes: Array<WorkerOutcome | undefined> = new Array(batch.length);
  let nextIssue = 0;
  let nextApply = 0;
  let applyChain: Promise<void> = Promise.resolve();
  const enqueueDrain = (): Promise<void> => {
    applyChain = applyChain.then(async () => {
      while (nextApply < batch.length && outcomes[nextApply] !== undefined) {
        const o = outcomes[nextApply]!;
        outcomes[nextApply] = undefined; // claimed — release for GC
        nextApply++;
        await applyOutcome(o);
      }
    });
    return applyChain;
  };
  const workerLoop = async (): Promise<void> => {
    while (true) {
      const i = nextIssue++;
      if (i >= batch.length) return;
      outcomes[i] = await runFileWorker(batch[i]!);
      void enqueueDrain();
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, batch.length || 1)) }, () => workerLoop()),
  );
  await enqueueDrain();

  // ── Binaries-only folders → asset observations ─────────────────────────
  // One name-only LLM call per folder whose every file skipped extraction
  // on mime. The model judges whether it's a meaningful asset collection
  // (Fonts, Logos, Brand Assets…) and emits the location fact + any asset
  // facts the names establish; non-collections return empty. Routing is
  // deterministic from the folder's attribution — campaign zone to the
  // campaign's bucket, account zone to the account bucket.
  let assetFoldersChecked = 0;
  let assetFolderObs = 0;
  for (const [folderKey, bf] of binaryOnlyFolders) {
    if (foldersWithText.has(folderKey)) continue;
    assetFoldersChecked++;
    try {
      const res = await timed('interpret_asset_folder', () =>
        interpretAssetFolder({
          accountName: ctx.accountName,
          campaignName:
            bf.attribution.ownerType === 'campaign' ? bf.attribution.campaignName : null,
          folderPath: bf.folderPath,
          fileNames: bf.fileNames,
        }),
      );
      if (res.observations.length === 0) continue;
      log(
        `    ◈ ${bf.folderPath}  (${bf.fileNames.length} binaries) → ${res.observations.length} asset obs  [${res.driver}]`,
      );
      for (const obs of res.observations) {
        pushRoutedObs(obs, bf.firstFileId, bf.attribution);
        assetFolderObs++;
      }
    } catch (err) {
      log(`    ✗ asset-folder interpret failed for ${bf.folderPath}: ${summarizeError(err)}`);
    }
  }

  // Materialize campaign-bucket list for the outcome + summary printing.
  const campaignBucketsList: CampaignBucket[] = Array.from(campaignBuckets.values()).sort(
    (a, b) => b.observations.length - a.observations.length,
  );
  const campaignObsTotal =
    campaignBucketsList.reduce((sum, b) => sum + b.observations.length, 0) +
    legacyCampaignBucket.length;

  log(
    `  → Extracted OK: ${filesExtracted}  Skipped: ${filesSkipped}  Errored: ${filesErrored}  Restricted: ${filesRestricted}  Zero obs: ${filesZeroObs}`,
  );
  if (filesRestricted > 0) {
    log(
      `  ⛔ ${filesRestricted} restricted file(s) on the worklist — re-probed each scan; fix sharing or mark Ignore in gub-admin`,
    );
  }
  if (filesRestored > 0) {
    log(`  🔓 ${filesRestored} previously restricted file(s) restored this scan`);
  }
  log('');

  // ── Per-entity observation breakdown ───────────────────────────────────
  log('  ── Observation buckets ──');
  log(`    Account "${ctx.accountName}"  ·  ${accountBucket.length} obs`);
  if (attributor) {
    for (const b of campaignBucketsList) {
      const tag =
        b.campaignStatus === 'existing'
          ? 'existing'
          : b.bucketSource === 'phantom'
            ? 'NEW (phantom — no folder)'
            : 'NEW candidate';
      log(
        `    Campaign "${b.campaignName}"  (${tag})  ·  ${b.observations.length} obs across ${b.fileIds.size} file(s)`,
      );
    }
    if (campaignBucketsList.length === 0) {
      log('    (no campaign-attributed files in this batch)');
    }
    if (accountLevelFiles > 0) {
      log(
        `    Account-level files: ${accountLevelFiles}  ·  untagged campaign obs discarded: ${campaignObsDiscarded}`,
      );
    }
    if (fuzzyMatchedObs > 0) {
      log(`    Fuzzy-matched obs (typo-corrected): ${fuzzyMatchedObs}`);
    }
  }

  for (const pb of pieceBuckets.values()) {
    log(`    Piece "${pb.pieceName}" (campaign "${pb.campaignName}")  ·  ${pb.observations.length} obs`);
  }
  if (foreignObsDropped > 0) {
    log(`    ⚠ ${foreignObsDropped} foreign-campaign obs dropped (misfiled content — the campaign zone is locked)`);
  }
  if (unknownCampaignToAccount > 0) {
    log(`    ↑ ${unknownCampaignToAccount} unknown-campaign obs converted to account observations (no phantoms)`);
  }
  if (assetFoldersChecked > 0) {
    log(`    ◈ Binaries-only folders: ${assetFoldersChecked} checked → ${assetFolderObs} asset obs`);
  }
  if (ideaCtx && ideaCtx.stats.deckFiles > 0) {
    const i = ideaCtx.stats;
    log(
      `    Ideas: ${i.deckFiles} deck file(s) → ${i.ideasCreated} created, ${i.ideasUpdated} updated, ${i.ideasUnchanged} unchanged${i.ideaErrors > 0 ? `, ${i.ideaErrors} error(s)` : ''}${applyToDb ? '' : ' (dryrun — not persisted)'}`,
    );
  }
  if (legacyCampaignBucket.length > 0 && !attributor) {
    // Campaign scan: report the single bucket plainly.
    log(`    Campaign "${ctx.campaignName ?? ctx.name}"  ·  ${legacyCampaignBucket.length} obs`);
  }
  log('');

  // ── Stage 3: per-entity distill + synthesize ───────────────────────────
  //
  // For each entity that has a non-empty observation bucket: distill its
  // observations (skipped for NEW candidates — there's no DB row to attach
  // proposals to; that path lives in proposeNewEntity), then synthesize
  // its status_markdown.
  //
  // For account scans: account + each campaign bucket from Stage 2.
  // For campaign scans: just the scanned campaign (legacy single bucket).
  //
  // Each per-entity LLM call is small (operates on the bucket digest, not
  // file content), so N entities = N cheap calls, not N expensive
  // re-extractions. The file-extraction work above ran ONCE per file.

  interface Target {
    entityType: 'account' | 'campaign' | 'piece';
    entityName: string;
    entityStatus: 'account' | 'existing' | 'new' | 'piece';
    /** For piece targets: the owning campaign (absorb-up destination). */
    pieceCampaignId?: string | null;
    pieceCampaignName?: string | null;
    entityId: string | null; // null for new candidates; otherwise account or campaign id
    /** Campaign-root folder id. Set for both existing + new candidate targets. */
    campaignFolderId: string | null;
    /** Deterministic breadcrumb for the folder (see PersistTarget). */
    campaignFolderPath: string | null;
    accountState: AccountCurrentState;
    campaignState: CampaignCurrentState | null;
    /** Prior persisted status_markdown (general) — merge base for general tier. */
    priorStatusMarkdown: string | null;
    /** Prior persisted status_sensitive_markdown — merge base for sensitive tier. */
    priorSensitiveMarkdown: string | null;
    observations: Array<
      | { observation: AccountObservation; sourceFileId: string }
      | { observation: CampaignObservation; sourceFileId: string }
    >;
    fileIds: Set<string>;
  }

  const targets: Target[] = [];

  if (accountBucket.length > 0) {
    targets.push({
      entityType: 'account',
      entityName: ctx.accountName,
      entityStatus: 'account',
      entityId: ctx.type === 'account' ? ctx.id : null,
      campaignFolderId: null,
      campaignFolderPath: null,
      accountState: ctx.accountState,
      campaignState: null,
      priorStatusMarkdown: ctx.statusMarkdown,
      priorSensitiveMarkdown: ctx.statusSensitiveMarkdown,
      observations: accountBucket,
      fileIds: new Set(accountBucket.map((o) => o.sourceFileId)),
    });
  }

  if (attributor) {
    // Account scan with structure → per-campaign targets. Load full DB
    // rows for existing campaigns so distillation has the right current
    // state (no-op detection + writable-field comparison). Also pulls
    // their prior status_markdown so the merge-on-subsequent-scans path
    // can layer today's bullets on top of yesterday's.
    const existingIds = campaignBucketsList
      .filter((b): b is CampaignBucket & { matchedCampaignId: string } =>
        b.campaignStatus === 'existing' && !!b.matchedCampaignId,
      )
      .map((b) => b.matchedCampaignId);

    const existingRows =
      existingIds.length > 0
        ? await prisma.campaign.findMany({ where: { id: { in: existingIds } } })
        : [];
    const stateByCampaignId = new Map<string, CampaignCurrentState>(
      existingRows.map((c) => [c.id, buildCampaignCurrentState(c)]),
    );
    const statusMdByCampaignId = new Map<string, string | null>(
      existingRows.map((c) => [c.id, c.statusMarkdown ?? null]),
    );
    const sensitiveMdByCampaignId = new Map<string, string | null>(
      existingRows.map((c) => [c.id, c.statusSensitiveMarkdown ?? null]),
    );

    for (const bucket of campaignBucketsList) {
      if (bucket.observations.length === 0) continue;
      const campaignState =
        bucket.matchedCampaignId && stateByCampaignId.has(bucket.matchedCampaignId)
          ? stateByCampaignId.get(bucket.matchedCampaignId)!
          : EMPTY_CAMPAIGN_STATE;
      const priorStatusMarkdown =
        bucket.matchedCampaignId && statusMdByCampaignId.has(bucket.matchedCampaignId)
          ? statusMdByCampaignId.get(bucket.matchedCampaignId) ?? null
          : null;
      const priorSensitiveMarkdown =
        bucket.matchedCampaignId && sensitiveMdByCampaignId.has(bucket.matchedCampaignId)
          ? sensitiveMdByCampaignId.get(bucket.matchedCampaignId) ?? null
          : null;
      targets.push({
        entityType: 'campaign',
        entityName: bucket.campaignName,
        entityStatus: bucket.campaignStatus,
        entityId: bucket.matchedCampaignId,
        campaignFolderId: bucket.campaignFolderId,
        campaignFolderPath:
          bucket.campaignFolderId !== null
            ? folderPathById?.get(bucket.campaignFolderId) ?? null
            : null,
        accountState: ctx.accountState,
        campaignState,
        priorStatusMarkdown,
        priorSensitiveMarkdown,
        observations: bucket.observations,
        fileIds: bucket.fileIds,
      });
    }
  } else if (legacyCampaignBucket.length > 0) {
    // Campaign scan: one target, the scanned campaign.
    targets.push({
      entityType: 'campaign',
      entityName: ctx.campaignName ?? ctx.name,
      entityStatus: 'existing',
      entityId: ctx.id,
      campaignFolderId: ctx.folderId,
      campaignFolderPath: null,
      accountState: ctx.accountState,
      campaignState: ctx.campaignState ?? EMPTY_CAMPAIGN_STATE,
      priorStatusMarkdown: ctx.statusMarkdown,
      priorSensitiveMarkdown: ctx.statusSensitiveMarkdown,
      observations: legacyCampaignBucket,
      fileIds: new Set(legacyCampaignBucket.map((o) => o.sourceFileId)),
    });
  }

  // Piece targets — one per piece bucket with observations. Pieces are
  // markdown-only synthesis targets: no writable fields, no distillation,
  // prior markdown from the campaign_pieces row.
  const pieceBucketsList = Array.from(pieceBuckets.values());
  if (pieceBucketsList.length > 0) {
    const pieceRowsForTargets = await prisma.campaignPiece.findMany({
      where: { id: { in: pieceBucketsList.map((b) => b.pieceId) } },
      select: { id: true, statusMarkdown: true, statusSensitiveMarkdown: true },
    });
    const pieceRowById = new Map(pieceRowsForTargets.map((r) => [r.id, r]));
    for (const pb of pieceBucketsList) {
      if (pb.observations.length === 0) continue;
      const row = pieceRowById.get(pb.pieceId);
      targets.push({
        entityType: 'piece',
        entityName: pb.pieceName,
        entityStatus: 'piece',
        entityId: pb.pieceId,
        campaignFolderId: pb.pieceFolderId,
        campaignFolderPath: null,
        pieceCampaignId: pb.campaignId,
        pieceCampaignName: pb.campaignName,
        accountState: ctx.accountState,
        campaignState: null,
        priorStatusMarkdown: row?.statusMarkdown ?? null,
        priorSensitiveMarkdown: row?.statusSensitiveMarkdown ?? null,
        observations: pb.observations,
        fileIds: pb.fileIds,
      });
    }
  }

  const synthesized: EntitySynthesisResult[] = [];

  if (targets.length === 0) {
    log('  (no entities with observations — nothing to distill or synthesize)');
  } else {
    log(
      `  Distill + synthesize ${targets.length} entit${targets.length === 1 ? 'y' : 'ies'}…  (concurrency=${config.SYNTH_CONCURRENCY})`,
    );

    // Per-entity work is fully independent: each entity owns its own
    // status_markdown row (one per account, one per campaign), no two
    // workers touch the same row, and reads/writes don't cross. Worker
    // pool with bounded concurrency (config.SYNTH_CONCURRENCY, default 8)
    // — see helper + config docstrings for rate-limit + DB-pool sizing.
    //
    // Log lines from the worker body are buffered locally and flushed
    // as a single contiguous block when the worker finishes its entity.
    // JS is single-threaded at await boundaries, so the for-loop flush
    // can't be preempted by another worker — each entity's block is
    // atomic in the output, even though entity order may not match
    // input order.
    const synthesizeTarget = async (target: Target): Promise<EntitySynthesisResult> => {
      const lineBuffer: string[] = [];
      const wlog = (line = ''): void => {
        lineBuffer.push(line);
      };

      wlog('');
      const statusTag =
        target.entityStatus === 'account' ? 'account'
        : target.entityStatus === 'existing' ? 'existing campaign'
        : target.entityStatus === 'piece' ? `piece of "${target.pieceCampaignName ?? '?'}"`
        : 'NEW campaign candidate';
      wlog(`  • ${statusTag}: "${target.entityName}"  ·  ${target.observations.length} obs / ${target.fileIds.size} file(s)`);

      // ── Distill (uniform across all entity kinds) ──────────────────────
      // Every target — account, existing campaign, new candidate — runs the
      // same distillation prompt, and we apply the resulting field_changes
      // to the target's CurrentState so the synthesized at-a-glance bullets
      // reflect current values + this scan's updates layered on top.
      //
      // NO PROPOSALS, BY DESIGN: the engine writes entity columns and
      // *_changes rows directly with system-staff attribution (see
      // persistTarget). distillAndEmit/proposeNewEntity are the v1
      // review-gated pipeline's writers, not this engine's.
      let distillResult: EntitySynthesisResult['distillResult'] = null;
      let validatedChanges: ValidatedChange[] = [];
      if (target.entityType === 'piece') {
        // Pieces are markdown-only: no writable fields → nothing to distill.
        // Observations flow straight into synthesis below.
        wlog('      (piece — markdown-only; distillation skipped)');
      } else
      try {
        // Captured OUTSIDE the closure: property narrowing ('piece' excluded
        // by the guard above) doesn't propagate into callbacks.
        const distillEntityType: 'account' | 'campaign' =
          target.entityType === 'account' ? 'account' : 'campaign';
        const baseState =
          target.entityType === 'account'
            ? target.accountState
            : (target.campaignState ?? EMPTY_CAMPAIGN_STATE);
        const dry = await timed('distill', () =>
          runDryRunDistillation(
            distillEntityType,
            target.observations,
            baseState,
          ),
        );
        distillResult = {
          proposalsCreated: dry.field_changes.length,
          notesWritten: dry.notes.length,
          ambiguousWritten: 0,
          driver: dry.driver,
        };

        // Validate every proposed field, drop no-ops + invalids. Same
        // gates production review uses on approve — backfill mirrors
        // them so auto-applied state matches what a reviewer-approved
        // sync would produce.
        const writeSpecs =
          target.entityType === 'account'
            ? (ACCOUNT_FIELD_WRITE as Record<string, FieldWriteSpec>)
            : (CAMPAIGN_FIELD_WRITE as Record<string, FieldWriteSpec>);

        let invalidCount = 0;
        let noOpCount = 0;
        for (const fc of dry.field_changes) {
          const spec = writeSpecs[fc.field];
          if (!spec) {
            invalidCount += 1;
            continue;
          }
          const validation = validateProposedValue(
            target.entityType,
            fc.field,
            fc.proposed_value ?? null,
          );
          if (!validation.ok) {
            invalidCount += 1;
            wlog(`        ⚠ skip "${fc.field}": ${validation.reason}`);
            continue;
          }
          const currentValue =
            target.entityType === 'account'
              ? target.accountState[fc.field as keyof AccountCurrentState] ?? null
              : (target.campaignState ?? EMPTY_CAMPAIGN_STATE)[fc.field as keyof CampaignCurrentState] ?? null;
          if (isNoOpChange(target.entityType, fc.field, currentValue, validation.value)) {
            noOpCount += 1;
            continue;
          }
          validatedChanges.push({
            field: fc.field,
            spec,
            validatedValue: validation.value,
            previousValue: currentValue,
            proposedValueRaw: fc.proposed_value ?? null,
            confidence: fc.confidence,
          });
        }

        const verb = target.entityStatus === 'new' ? 'would propose' : 'would update';
        const persistTag = applyToDb ? '' : ' (dryrun — not persisted)';
        wlog(
          `      ${verb}: ${validatedChanges.length} field changes${invalidCount > 0 ? ` (${invalidCount} invalid)` : ''}${noOpCount > 0 ? ` (${noOpCount} no-op)` : ''}, ${dry.notes.length} notes  [${dry.driver}]${persistTag}`,
        );

        // Layer validated proposed values onto the rendering state so
        // synthesis sees the post-apply at-a-glance.
        if (target.entityType === 'account') {
          const populated: AccountCurrentState = { ...target.accountState };
          for (const vc of validatedChanges) {
            (populated as Record<string, string | null>)[vc.field] = vc.proposedValueRaw;
          }
          target.accountState = populated;
        } else {
          const populated: CampaignCurrentState = {
            ...(target.campaignState ?? EMPTY_CAMPAIGN_STATE),
          };
          for (const vc of validatedChanges) {
            (populated as Record<string, string | null>)[vc.field] = vc.proposedValueRaw;
          }
          target.campaignState = populated;
        }

        for (const vc of validatedChanges) {
          const val = vc.proposedValueRaw ?? '(null)';
          wlog(`        · ${vc.field} = ${val}  (${(vc.confidence * 100).toFixed(0)}%)`);
        }
      } catch (err) {
        wlog(`      distill failed: ${summarizeError(err)}`);
      }

      // ── Synthesize (dual-output: general + sensitive) ───────────────
      const synthStart = Date.now();
      let synthFailed = false;
      let synthesizedMarkdown: string;
      let synthesizedSensitiveMarkdown: string | null = null;
      try {
        const approvedAdditionalUpdates = target.observations.map((o) => ({
          text: o.observation.text,
          source_file_ids: [o.sourceFileId],
          // No reviewer-set sensitive flag during backfill — LLM classifies
          // via the rubric in the prompt. Forward sync (when wired) will
          // populate this from the reviewer's per-item toggle.
        }));
        const atAGlanceMap =
          target.entityType === 'account'
            ? accountFieldsAsMap(target.accountState)
            : target.entityType === 'piece'
              ? { Name: target.entityName, Campaign: target.pieceCampaignName ?? '—' }
              : campaignFieldsAsMap(target.campaignState ?? EMPTY_CAMPAIGN_STATE);
        // Per D23: pre-prune expired transient bullets from prior blobs
        // BEFORE the LLM sees them. asOfDate = the scan day = editedAt.
        const priorGeneralTransient = pruneExpiredTransientBullets(
          extractTransientSection(target.priorStatusMarkdown ?? ''),
          editedAt,
        );
        const priorSensitiveTransient = pruneExpiredTransientBullets(
          extractTransientSection(target.priorSensitiveMarkdown ?? ''),
          editedAt,
        );

        const renderedPrompt = renderStatusSynthesisV1Prompt({
          entityType: target.entityType,
          entityName: target.entityName,
          parentContext:
            target.entityType === 'campaign'
              ? `account: ${ctx.accountName}`
              : target.entityType === 'piece'
                ? `campaign: ${target.pieceCampaignName ?? '?'} · account: ${ctx.accountName}`
                : null,
          // Merge per-tier × per-durability against prior bullets (D25 + D23).
          currentContextBullets: extractContextSection(target.priorStatusMarkdown ?? '') ?? null,
          currentSensitiveBullets: extractContextSection(target.priorSensitiveMarkdown ?? '') ?? null,
          currentGeneralTransientBullets: priorGeneralTransient,
          currentSensitiveTransientBullets: priorSensitiveTransient,
          scanDay: editedAt,
          atAGlanceJson: JSON.stringify(atAGlanceMap, null, 2),
          approvedFieldChangesJson: JSON.stringify([], null, 2),
          approvedAdditionalUpdatesJson: JSON.stringify(approvedAdditionalUpdates, null, 2),
        });
        const res = await timed('synthesis', () =>
          defaultLlm.complete({
            model: 'gemini-3.5-flash',
            temperature: 0.2,
            prompt: renderedPrompt,
            tag: `backfill.${STATUS_SYNTHESIS_V1_VERSION}`,
          }),
        );
        // Parse the quad-output. If delimiters are missing, the parser
        // gates the whole response as sensitive — safer than leaking.
        const parsed = parseQuadContextOutput(res.text);
        const bullets = renderAtAGlanceBullets({
          entityType: target.entityType,
          ...(target.entityType === 'account'
            ? { accountState: target.accountState }
            : target.entityType === 'piece'
              ? { pieceFields: { Name: target.entityName, Campaign: target.pieceCampaignName ?? '—' } }
              : { campaignState: target.campaignState ?? EMPTY_CAMPAIGN_STATE }),
        });
        synthesizedMarkdown = assembleStatusMarkdown({
          editedAt,
          bullets,
          contextProse: parsed.generalContext,
          transientProse: parsed.generalTransient,
        });
        synthesizedSensitiveMarkdown =
          parsed.sensitiveContext || parsed.sensitiveTransient
            ? assembleSensitiveStatusMarkdown({
                editedAt,
                contextProse: parsed.sensitiveContext,
                transientProse: parsed.sensitiveTransient,
              })
            : null;
      } catch (err) {
        // Placeholder is for the LOG/result display only — it must never
        // reach the DB: persistTarget writes statusMarkdown unconditionally,
        // so persisting it would clobber the entity's accumulated dossier
        // with "(synthesis failed…)", and since the cursor still advances,
        // the day would never re-run to restore it.
        synthFailed = true;
        synthesizedMarkdown = `(synthesis failed: ${summarizeError(err)})`;
      }
      const synthesisMs = Date.now() - synthStart;
      wlog(
        `      synthesized in ${fmtMs(synthesisMs)}${synthesizedSensitiveMarkdown ? ' (general + sensitive)' : ''}`,
      );

      // ── Apply (unless --dryrun) ─────────────────────────────────────
      if (applyToDb) {
        if (synthFailed) {
          wlog("      ✗ NOT applied — synthesis failed; keeping the entity's prior status_markdown");
        } else {
          try {
            await timed('db_writes', () =>
              persistTarget({
                target,
                ctx,
                validatedChanges,
                synthesizedMarkdown,
                synthesizedSensitiveMarkdown,
              }),
            );
            wlog('      ✓ applied (system-staff attribution)');
          } catch (err) {
            wlog(`      apply failed: ${summarizeError(err)}`);
          }
        }
      }

      // Flush this entity's buffered log lines as one atomic block.
      // Synchronous calls to log() — no await between them — so another
      // worker can't interleave its flush in the middle of ours.
      for (const line of lineBuffer) log(line);

      return {
        entityType: target.entityType,
        entityName: target.entityName,
        entityStatus: target.entityStatus,
        observationsCount: target.observations.length,
        filesCount: target.fileIds.size,
        distillResult,
        synthesizedMarkdown,
        synthesizedSensitiveMarkdown,
        synthesisMs,
      };
    };

    // ── Two-phase walk: pieces FIRST, then account/campaigns ─────────────
    // A piece's high-level rolls up into its owning campaign's synthesis in
    // the SAME scan (absorb-up), so pieces must finish before campaigns start.
    const pieceTargets = targets.filter((t) => t.entityType === 'piece');
    const mainTargets = targets.filter((t) => t.entityType !== 'piece');

    const pieceResults =
      pieceTargets.length > 0
        ? await runWithConcurrency(pieceTargets, config.SYNTH_CONCURRENCY, synthesizeTarget)
        : [];

    // Absorb-up: one rollup bullet per piece, injected into the owning
    // campaign target through the SAME channel as any approved bullet — the
    // campaign synthesis dedupes/supersedes it like everything else. The
    // stable source id `piece:<id>` keys supersession across re-runs.
    // When the campaign has no direct obs this scan (piece-only day), a
    // campaign target is CREATED so the rollup merges into the campaign's
    // prior markdown NOW — a later scan won't have this piece's synthesis
    // in hand, so deferring would drop the rollup.
    for (let i = 0; i < pieceTargets.length; i++) {
      const pt = pieceTargets[i]!;
      const pr = pieceResults[i];
      if (!pr || !pt.pieceCampaignId) continue;
      const contextLines = (extractContextSection(pr.synthesizedMarkdown) ?? '')
        .split('\n')
        .map((l) => l.replace(/^-\s?/, '').trim())
        .filter(Boolean);
      const lead = contextLines[0];
      if (!lead) continue;
      let campaignTarget = mainTargets.find(
        (t) => t.entityType === 'campaign' && t.entityId === pt.pieceCampaignId,
      );
      if (!campaignTarget) {
        const row = await prisma.campaign.findUnique({ where: { id: pt.pieceCampaignId } });
        if (!row) continue;
        campaignTarget = {
          entityType: 'campaign',
          entityName: row.name,
          entityStatus: 'existing',
          entityId: row.id,
          campaignFolderId: row.driveFolderId,
          campaignFolderPath: null,
          accountState: ctx.accountState,
          campaignState: buildCampaignCurrentState(row),
          priorStatusMarkdown: row.statusMarkdown ?? null,
          priorSensitiveMarkdown: row.statusSensitiveMarkdown ?? null,
          observations: [],
          fileIds: new Set(),
        };
        mainTargets.push(campaignTarget);
      }
      // Deterministic dedupe: if the campaign's prior markdown already carries
      // this exact rollup line, don't re-inject — the synthesis LLM does not
      // reliably collapse identical bullets, and re-runs would stack copies.
      if (campaignTarget.priorStatusMarkdown?.includes(lead)) {
        continue;
      }
      campaignTarget.observations.push({
        observation: { text: `Piece "${pt.entityName}": ${lead}` } as CampaignObservation,
        sourceFileId: `piece:${pt.entityId}`,
      });
      log(`  ↑ absorb-up: piece "${pt.entityName}" → campaign "${campaignTarget.entityName}"`);
    }

    const mainResults =
      mainTargets.length > 0
        ? await runWithConcurrency(mainTargets, config.SYNTH_CONCURRENCY, synthesizeTarget)
        : [];

    synthesized.push(...pieceResults, ...mainResults);
  }

  return {
    filesAttempted: batch.length,
    filesExtracted,
    filesSkipped,
    filesErrored,
    filesZeroObs,
    accountObsTotal: accountBucket.length,
    campaignObsTotal,
    campaignBuckets: campaignBucketsList,
    accountLevelFiles,
    campaignObsDiscarded,
    synthesized,
    ideaStats: ideaCtx?.stats ?? null,
  };
}
