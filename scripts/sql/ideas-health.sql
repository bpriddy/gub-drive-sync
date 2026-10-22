-- ideas-health.sql — read-only health checks for the ideas memory tier (#70).
--
-- Run with psql against the GUB database:
--
--   psql "$DATABASE_URL" -f scripts/sql/ideas-health.sql
--
-- Everything runs inside a READ ONLY transaction that is rolled back at the
-- end, so no statement can write. Cost: plain SELECTs; section 1 is a
-- self-join per account (n² pairs per account), fine at thousands of ideas.
-- Needs pg_trgm, which the GUB migrations install.
--
-- Sections 1, 3 and 4 list idea names: that output is customer data. Keep
-- it out of tickets, chats and this repository; share the counts only.

\set ON_ERROR_STOP on
\pset pager off

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '120s';

-- ── 0. Size and fill rates ─────────────────────────────────────────────────
-- Expect no_source_file = 0 (both writers set it). with_pitched_at and
-- with_piece are expected to be 0 today: no code writes ideas.pitched_at or
-- ideas.piece_id yet.
\echo '== 0. Size and fill rates'
SELECT count(*)                                            AS ideas,
       count(DISTINCT account_external_id)                 AS accounts,
       count(*) FILTER (WHERE source_file_id IS NULL)      AS no_source_file,
       count(*) FILTER (WHERE campaign_external_id IS NULL) AS no_campaign,
       count(*) FILTER (WHERE pitched_at IS NOT NULL)      AS with_pitched_at,
       count(*) FILTER (WHERE piece_id IS NOT NULL)        AS with_piece,
       count(*) FILTER (WHERE NOT EXISTS (
         SELECT 1 FROM accounts a WHERE a.drive_folder_id = i.account_external_id
       ))                                                  AS no_account_row,
       min(created_at)                                     AS first_created,
       max(created_at)                                     AS last_created
FROM ideas i;

-- ── 1. Trigram near-duplicates within an account ───────────────────────────
-- Pairs the matcher kept apart. 1a: names alike (similarity >= 0.5). 1b:
-- names unlike but facets alike, which is how a missed rename shows up.
-- Each pair is a merge candidate or a deliberate split; read the facets.
\echo '== 1a. Near-duplicate names within an account (name similarity >= 0.5)'
SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = x.account_external_id) AS account,
       x.name                                                              AS idea_a,
       y.name                                                              AS idea_b,
       round(similarity(x.name, y.name)::numeric, 2)                       AS name_sim,
       round(similarity(array_to_string(x.facets, ' '),
                        array_to_string(y.facets, ' '))::numeric, 2)       AS facet_sim,
       x.id AS id_a,
       y.id AS id_b
FROM ideas x
JOIN ideas y ON y.account_external_id = x.account_external_id AND x.id < y.id
WHERE similarity(x.name, y.name) >= 0.5
ORDER BY name_sim DESC, account, idea_a
LIMIT 50;

\echo '== 1b. Different names, alike facets (name similarity < 0.5, facet similarity >= 0.5)'
SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = x.account_external_id) AS account,
       x.name                                                              AS idea_a,
       y.name                                                              AS idea_b,
       round(similarity(x.name, y.name)::numeric, 2)                       AS name_sim,
       round(similarity(array_to_string(x.facets, ' '),
                        array_to_string(y.facets, ' '))::numeric, 2)       AS facet_sim,
       x.id AS id_a,
       y.id AS id_b
FROM ideas x
JOIN ideas y ON y.account_external_id = x.account_external_id AND x.id < y.id
WHERE similarity(x.name, y.name) < 0.5
  AND similarity(array_to_string(x.facets, ' '), array_to_string(y.facets, ' ')) >= 0.5
ORDER BY facet_sim DESC, account, idea_a
LIMIT 50;

\echo '== 1c. Near-duplicate pairs per account (counts of 1a and 1b, no limit)'
SELECT account, name_pairs, facet_only_pairs
FROM (
  SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = p.account_external_id) AS account,
         count(*) FILTER (WHERE p.name_sim >= 0.5)                         AS name_pairs,
         count(*) FILTER (WHERE p.name_sim < 0.5 AND p.facet_sim >= 0.5)  AS facet_only_pairs
  FROM (
    SELECT x.account_external_id,
           similarity(x.name, y.name) AS name_sim,
           similarity(array_to_string(x.facets, ' '), array_to_string(y.facets, ' ')) AS facet_sim
    FROM ideas x
    JOIN ideas y ON y.account_external_id = x.account_external_id AND x.id < y.id
  ) p
  GROUP BY p.account_external_id
) t
WHERE name_pairs + facet_only_pairs > 0
ORDER BY name_pairs + facet_only_pairs DESC, account;

-- ── 2. Ideas without a source file ─────────────────────────────────────────
-- Expect 0 rows in 2a. 2b counts source files the file index does not hold;
-- while the index is stale, ideas created after its last write land here,
-- so compare against the index's newest scanned_at.
\echo '== 2a. Ideas without source_file_id, per account'
SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = i.account_external_id) AS account,
       count(*)                                                     AS ideas,
       min(i.created_at)                                            AS first_created,
       max(i.created_at)                                            AS last_created
FROM ideas i
WHERE i.source_file_id IS NULL
GROUP BY i.account_external_id
ORDER BY ideas DESC;

\echo '== 2b. source_file_id unknown to the file index (drive_file_snapshots)'
SELECT count(*) FILTER (WHERE i.source_file_id IS NOT NULL)                  AS with_source,
       count(*) FILTER (WHERE i.source_file_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM drive_file_snapshots s WHERE s.file_id = i.source_file_id
       ))                                                                    AS source_not_indexed,
       (SELECT max(scanned_at) FROM drive_file_snapshots)                    AS index_newest_scan
FROM ideas i;

-- ── 3. Facet distribution ──────────────────────────────────────────────────
-- 3a/3b: shape. Ideas with 0 facets have no description. A long tail of
-- 20+ facets is the umbrella-absorption sign the matcher prompt warns of.
\echo '== 3a. Facets per idea'
SELECT cardinality(facets) AS facets, count(*) AS ideas
FROM ideas
GROUP BY 1
ORDER BY 1;

\echo '== 3b. Percentiles: facets per idea, characters per facet row'
SELECT (SELECT percentile_disc(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP (ORDER BY cardinality(facets))
          FROM ideas)                                              AS facets_p50_p90_p99,
       (SELECT max(cardinality(facets)) FROM ideas)                AS facets_max,
       (SELECT percentile_disc(ARRAY[0.1, 0.5, 0.9]) WITHIN GROUP (ORDER BY length(f))
          FROM ideas, unnest(facets) AS f)                         AS row_chars_p10_p50_p90,
       (SELECT count(*) FROM ideas, unnest(facets) AS f)           AS facet_rows;

-- 3c: an idea that repeats a facet row (case-insensitive) should have been
-- collapsed by the merge. Expect 0.
\echo '== 3c. Ideas that repeat a facet row'
SELECT count(*) AS ideas_with_repeated_row
FROM ideas i
WHERE cardinality(i.facets) >
      (SELECT count(DISTINCT lower(btrim(f))) FROM unnest(i.facets) AS f);

-- 3d: rows shared across ideas. Tone and format rows recur by nature; a row
-- shared by many ideas of one account may be boilerplate leaking in.
\echo '== 3d. Facet rows shared by more than one idea (top 20)'
SELECT lower(btrim(f)) AS facet_row, count(DISTINCT id) AS ideas, count(DISTINCT account_external_id) AS accounts
FROM ideas, unnest(facets) AS f
GROUP BY 1
HAVING count(DISTINCT id) > 1
ORDER BY ideas DESC, facet_row
LIMIT 20;

\echo '== 3e. Largest ideas (umbrella candidates, top 10)'
SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = i.account_external_id) AS account,
       i.name,
       cardinality(i.facets) AS facets,
       i.id
FROM ideas i
ORDER BY cardinality(i.facets) DESC NULLS LAST, i.created_at
LIMIT 10;

-- ── 4. Change-log churn (idea_changes) ─────────────────────────────────────
-- 4a: integrity. Both writers log a birth row (previous_value_text NULL) in
-- the same transaction as the create. Expect both counts 0.
\echo '== 4a. Birth rows: ideas with none, ideas with several'
SELECT count(*) FILTER (WHERE births = 0) AS ideas_without_birth_row,
       count(*) FILTER (WHERE births > 1) AS ideas_with_several_birth_rows
FROM (
  SELECT i.id, count(c.id) FILTER (WHERE c.previous_value_text IS NULL) AS births
  FROM ideas i
  LEFT JOIN idea_changes c ON c.idea_id = i.id AND c.property = 'facets'
  GROUP BY i.id
) t;

\echo '== 4b. Rewrites per idea (change rows after the birth row)'
SELECT rewrites, count(*) AS ideas
FROM (
  SELECT i.id, count(c.id) FILTER (WHERE c.previous_value_text IS NOT NULL) AS rewrites
  FROM ideas i
  LEFT JOIN idea_changes c ON c.idea_id = i.id AND c.property = 'facets'
  GROUP BY i.id
) t
GROUP BY rewrites
ORDER BY rewrites;

-- 4c: the merge-depth signal from the design notes: an idea rewritten ten
-- times or more is a split-review candidate.
\echo '== 4c. Ideas rewritten 10+ times'
SELECT (SELECT min(a.name) FROM accounts a WHERE a.drive_folder_id = i.account_external_id) AS account,
       i.name,
       count(c.id)              AS rewrites,
       cardinality(i.facets)    AS facets_now,
       min(c.changed_at)        AS first_rewrite,
       max(c.changed_at)        AS last_rewrite,
       i.id
FROM ideas i
JOIN idea_changes c ON c.idea_id = i.id AND c.property = 'facets' AND c.previous_value_text IS NOT NULL
GROUP BY i.id
HAVING count(c.id) >= 10
ORDER BY rewrites DESC;

\echo '== 4d. Births and rewrites per week, last 12 weeks'
SELECT date_trunc('week', changed_at)::date                        AS week,
       count(*) FILTER (WHERE previous_value_text IS NULL)          AS births,
       count(*) FILTER (WHERE previous_value_text IS NOT NULL)      AS rewrites,
       count(DISTINCT idea_id)                                      AS ideas_touched
FROM idea_changes
WHERE property = 'facets' AND changed_at >= now() - interval '84 days'
GROUP BY 1
ORDER BY 1;

-- 4e: what rewrites do. noop = same text (the scan skips these, so expect
-- 0); same_size = a reword with no new row, the stochastic churn the scan's
-- delta gate is meant to bound; grew / shrank = facets added / superseded.
\echo '== 4e. Rewrite kinds'
SELECT count(*) FILTER (WHERE value_text = previous_value_text)              AS noop,
       count(*) FILTER (WHERE value_text <> previous_value_text AND n_new = n_old) AS same_size,
       count(*) FILTER (WHERE n_new > n_old)                                 AS grew,
       count(*) FILTER (WHERE n_new < n_old)                                 AS shrank
FROM (
  SELECT value_text,
         previous_value_text,
         cardinality(string_to_array(coalesce(value_text, ''), E'\n'))          AS n_new,
         cardinality(string_to_array(coalesce(previous_value_text, ''), E'\n')) AS n_old
  FROM idea_changes
  WHERE property = 'facets' AND previous_value_text IS NOT NULL
) t;

-- 4f: the latest change row should equal the idea's current facets, rendered
-- the way the writers render them ("- row" lines). A mismatch means the
-- facets changed without a log row. Expect 0.
\echo '== 4f. Ideas whose current facets differ from their latest change row'
SELECT count(*) AS ideas_out_of_step_with_log
FROM ideas i
JOIN LATERAL (
  SELECT c.value_text
  FROM idea_changes c
  WHERE c.idea_id = i.id AND c.property = 'facets'
  ORDER BY c.changed_at DESC, c.id DESC
  LIMIT 1
) last ON true
WHERE coalesce(last.value_text, '') IS DISTINCT FROM coalesce(
  (SELECT string_agg('- ' || f, E'\n' ORDER BY ord) FROM unnest(i.facets) WITH ORDINALITY AS u(f, ord)),
  '');

ROLLBACK;
