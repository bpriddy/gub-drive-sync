-- nuke-before-v2.sql
--
-- One-time data cleanup before the Drive Sync v2 schema migration ships.
-- Clears all backfill-generated content but PRESERVES the org structure
-- (accounts, campaigns, staff, offices, teams).
--
-- Run order:
--   1. Stop the existing Cloud Scheduler trigger that fires Drive backfills.
--   2. Cancel any in-flight drive_backfill_requests rows via the UI.
--   3. Run this script against the target DB (dev or prod).
--   4. Run the v2 Prisma migration.
--   5. Deploy the new gub-drive-sync image.
--   6. Re-bootstrap each account via the gub-admin UI.
--
-- Operator: verify the OPTIONAL campaign-delete block below. If any backfill-
-- auto-created campaigns represent real campaigns operators want to keep,
-- skip that block. Run `SELECT name, created_at FROM campaigns WHERE ...`
-- first and review.
--
-- Idempotent: safe to re-run; subsequent runs just no-op.

BEGIN;

-- ── Wipe backfill-generated audit log entries ──────────────────────────────
--
-- The Drive Sync system-staff UUID is the changed_by we attributed all
-- backfill writes to. Anything written by this identity is backfill output
-- and is being invalidated.

DELETE FROM account_changes
WHERE changed_by = 'dcd5d8e3-0000-4000-a000-000000000001';

DELETE FROM campaign_changes
WHERE changed_by = 'dcd5d8e3-0000-4000-a000-000000000001';

-- ── Wipe queued review-UI proposals ───────────────────────────────────────
--
-- These were the bridges between drive sync and the reviewer flow. With
-- v2, the bootstrap flow auto-applies its own observations (same model
-- as today). Proposals from the old flow are stale.

DELETE FROM drive_change_proposals;

-- ── Wipe per-file scan logs ───────────────────────────────────────────────

DELETE FROM drive_scan_logs;

-- ── Wipe backfill queue rows ──────────────────────────────────────────────
--
-- After the v2 migration, this table is renamed to drive_sync_runs. All
-- existing rows refer to the dead backfill model and have no value.

DELETE FROM drive_backfill_requests;

-- ── Reset per-account Drive sync state ────────────────────────────────────

UPDATE accounts SET
  status_markdown            = NULL,
  status_sensitive_markdown  = NULL,
  drive_backfill_cursor      = NULL,
  drive_last_scanned_at      = NULL;

-- ── Reset per-campaign synthesis state ────────────────────────────────────

UPDATE campaigns SET
  status_markdown            = NULL,
  status_sensitive_markdown  = NULL;

-- ── OPTIONAL: delete backfill-auto-created campaigns ──────────────────────
--
-- Backfill auto-created campaign rows from drive-discovered folders. Some
-- of these may represent real campaigns. Review before uncommenting.
--
-- Suggested review query:
--
--   SELECT id, name, created_at
--   FROM campaigns
--   WHERE created_by = 'dcd5d8e3-0000-4000-a000-000000000001'
--   ORDER BY created_at;
--
-- If the list is all noise (drive folder names with no operational meaning),
-- uncomment this block:
--
-- DELETE FROM campaign_changes WHERE campaign_id IN (
--   SELECT id FROM campaigns WHERE created_by = 'dcd5d8e3-0000-4000-a000-000000000001'
-- );
-- DELETE FROM campaigns WHERE created_by = 'dcd5d8e3-0000-4000-a000-000000000001';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────
--
-- After commit, verify the wipe with:
--
--   SELECT COUNT(*) FROM drive_backfill_requests;            -- 0
--   SELECT COUNT(*) FROM drive_change_proposals;             -- 0
--   SELECT COUNT(*) FROM accounts WHERE status_markdown IS NOT NULL;  -- 0
--   SELECT COUNT(*) FROM campaigns WHERE status_markdown IS NOT NULL; -- 0
