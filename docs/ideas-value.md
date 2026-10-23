# Ideas: what the Drive scan adds

A one-page showcase of the ideas memory tier, with demo queries that run on
GUB data at no model cost. The output blocks are placeholders: fill them from
live data with **aggregates only** (counts, rates, distributions). This file
is public, so no account names, idea names or deck names go into it. A copy
with real examples belongs in a private document.

## What the pipeline produces

The scan reads every file it already processes. When the per-file call types
a file as a **pitch deck** or a **creative review deck**, a second call
extracts the ideas the deck itself presents: named concepts, territories or
routes. Each idea is a name plus a few short **facet** rows (tone, format,
channel, cultural hook, the core device). Everything else (briefs, strategy
and media plans, status decks, final creative) yields no ideas.

Each extracted idea is then **matched against the account's known ideas**:

- A renamed or refined round of the same concept merges into the existing
  row, and its facets are recomposed.
- A distinct concept becomes a new row.

Every create and every rewrite appends a row to **`idea_changes`**, so an
idea's history is never overwritten.

| Store | What it holds |
|---|---|
| `ideas` | One row per concept per account: `name`, `facets[]`, the account and campaign it belongs to (by Drive folder id), the deck it was first seen in (`source_file_id`), and the planned `pitched_at` / `piece_id` links |
| `idea_changes` | Append-only log: the birth row, then one row per rewrite, with the facets before and after |

GUB serves the tier to apps and the chat agent. Access is the
all-or-nothing `idea_all` grant:

- `GET /org/ideas`: filters on `accountId`, `campaignId`, `since` / `until` (on `pitchedAt`), `limit` up to 200. Returns name, facets, `pitchedAt`, account and campaign names, `awarded`.
- `GET /org/ideas/:id`: one idea.
- `GET /org/search?q=…&limit=…`: name search across entity types, ideas included, ranked by trigram word similarity. `limit` defaults to 20, is capped at 50, and is shared across the types.

Matching ideas by meaning is the caller's job, done over the returned facets.

## Why a file search does not answer these

A file search, or an assistant that reads the files a user can open, works
one file at a time. It finds a deck that mentions a phrase, or summarizes a
deck. The questions below need a record built **across decks and over
time**. That record has four parts:

- one entry per concept, even when its name changed between rounds;
- what the concept consisted of, as structured facet rows;
- when it first appeared;
- how it changed afterwards.

The scan builds and keeps that record.

## Demo queries

Run the SQL with psql, read-only, with operator access: it sees all
accounts. For an end-user demo, use the API calls, made with that user's
own token. Set the variables first:

```sql
\set account_id '<account uuid>'
\set idea_id '<idea uuid>'
\set phrase 'social-first'
```

API calls use a GUB access token for a user who holds `idea_all`. Without
that grant the ideas endpoints return an empty list, not an error, so check
the grant before reading a 0 as "no ideas".

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$GUB_URL/org/ideas?accountId=<account uuid>&limit=200"
```

### 1. "Have we already pitched something like this for this account?"

The account's idea memory, with facets. The agent matches the concept over
the facets. One call returns at most 200 ideas, ordered by `pitchedAt`.
Since no `pitchedAt` is set yet, an account with more than 200 ideas gets an
arbitrary 200; section 0 of the health checks gives the true count.

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$GUB_URL/org/ideas?accountId=<account uuid>&limit=200" \
  | jq '{returned: length, median_facets: (map(.facets | length) | sort | .[length / 2 | floor])}'
```

> **Output**: ideas returned (capped at 200): `<fill>`; median facets per idea: `<fill>`

### 2. Find an idea by a half-remembered name

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$GUB_URL/org/search?q=<words>&limit=50" \
  | jq '[.[] | select(.type == "idea")] | {idea_hits: length, best_similarity: (map(.similarity) | max)}'
```

> **Output**: idea hits for `<redacted phrase>` (out of at most 50 hits of all types): `<fill>`; best similarity: `<fill>`

### 3. Which ideas came back after their first deck (lineage)

Rewritten ideas are concepts that resurfaced in later rounds and were merged,
not duplicated. The birth deck's name comes from the file index
(`drive_file_snapshots`). The current scan does not write that index, so
`birth_deck` stays empty for the ideas the scan created until the index is
fixed; `source_file_id` is always set.

```sql
SELECT i.name,
       count(c.id) FILTER (WHERE c.previous_value_text IS NOT NULL) AS rewrites,
       min(c.changed_at)::date                                      AS first_seen,
       max(c.changed_at)::date                                      AS last_changed,
       s.name                                                       AS birth_deck
FROM ideas i
LEFT JOIN idea_changes c ON c.idea_id = i.id
LEFT JOIN LATERAL (
  SELECT name FROM drive_file_snapshots WHERE file_id = i.source_file_id ORDER BY scanned_at DESC LIMIT 1
) s ON true
WHERE i.account_external_id = (SELECT drive_folder_id FROM accounts WHERE id = :'account_id')
GROUP BY i.id, s.name
ORDER BY rewrites DESC, first_seen
LIMIT 10;
```

> **Output**: ideas with ≥ 1 rewrite: `<fill>` of `<fill>`; most rewrites on one idea: `<fill>`

**Gap:** a rewrite row does not record which deck caused it, so the lineage
shows the birth deck and the dates of later rounds, not each later deck. A
source-file column on `idea_changes` would close this. That is a schema
change, so it goes through gub-schemas first.

### 4. One idea's history

```sql
SELECT changed_at::date                                              AS day,
       CASE WHEN previous_value_text IS NULL THEN 'first seen' ELSE 'rewritten' END AS event,
       cardinality(string_to_array(value_text, E'\n'))                AS facets,
       value_text
FROM idea_changes
WHERE idea_id = :'idea_id'
ORDER BY changed_at;
```

> **Output** (shape only): events: `<fill>`; facets at birth → now: `<fill>` → `<fill>`

### 5. The pitch timeline

The API filters on `pitchedAt`, for example
`GET /org/ideas?accountId=…&since=2026-01-01&until=2026-06-30`.

**Gap:** no writer sets `pitched_at` yet, so this returns nothing today.
Until one does, the first-seen date stands in for it:

```sql
SELECT date_trunc('month', first_seen)::date AS month, count(*) AS new_ideas
FROM (
  SELECT i.id, coalesce(i.pitched_at::timestamptz, min(c.changed_at)) AS first_seen
  FROM ideas i
  JOIN idea_changes c ON c.idea_id = i.id
  WHERE i.account_external_id = (SELECT drive_folder_id FROM accounts WHERE id = :'account_id')
  GROUP BY i.id
) t
GROUP BY 1
ORDER BY 1;
```

The first-seen date is when the scan first saw the idea, not when it was
pitched. A backfill makes those two dates differ.

> **Output**: months covered: `<fill>`; ideas with `pitched_at` set: `<fill>` (expected 0 today)

### 6. Every idea that used a given device, tone or channel (facets)

```sql
SELECT i.name, f AS facet_row, round(word_similarity(:'phrase', f)::numeric, 2) AS sim
FROM ideas i, unnest(i.facets) AS f
WHERE i.account_external_id = (SELECT drive_folder_id FROM accounts WHERE id = :'account_id')
  AND :'phrase' <% f
ORDER BY sim DESC, i.name
LIMIT 20;
```

> **Output**: ideas matching `<redacted facet phrase>`: `<fill>`

### 7. The account's recurring creative devices

```sql
SELECT lower(btrim(f)) AS facet_row, count(*) AS ideas
FROM ideas i, unnest(i.facets) AS f
WHERE i.account_external_id = (SELECT drive_folder_id FROM accounts WHERE id = :'account_id')
GROUP BY 1
HAVING count(*) > 1
ORDER BY ideas DESC
LIMIT 10;
```

> **Output**: facet rows shared by ≥ 2 ideas: `<fill>`; most shared row used by `<fill>` ideas

### 8. Ideas per campaign

```sql
SELECT coalesce((SELECT min(c.name) FROM campaigns c WHERE c.drive_folder_id = i.campaign_external_id),
                '(no campaign)')                                  AS campaign,
       count(*)                                                   AS ideas
FROM ideas i
WHERE i.account_external_id = (SELECT drive_folder_id FROM accounts WHERE id = :'account_id')
GROUP BY 1
ORDER BY ideas DESC;
```

> **Output**: campaigns with ideas: `<fill>`; ideas per campaign, median: `<fill>`

### 9. Which ideas were produced

`awarded` in the API is `piece_id IS NOT NULL`.

**Gap:** nothing sets the link from an idea to the piece that realized it, so
every idea reads `awarded: false` today.

> **Output**: ideas with `awarded: true`: `<fill>` (expected 0 today)

## Health before showing it

Run `scripts/sql/ideas-health.sql` first, which is read-only. It reports
near-duplicates, ideas with no source deck, the facet distribution and
change-log churn. To measure extraction and merge quality on a gold set, see
the README section *Ideas eval*. That eval is paid, so it needs a go.
