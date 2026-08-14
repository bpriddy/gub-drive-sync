/**
 * forward/people.ts — Activity actor resolution: people/<id> → email.
 *
 * Activity events name actors as opaque People resources. We resolve
 * them through the People API using the DIRECTORY bot's credential
 * (contacts + directory scopes already granted — decision Q1, approved
 * 2026-08-13: one read-only lookup, no new consent), cached in
 * people_resource_map. Unresolved actors keep their raw resource name
 * downstream — all editors are tracked, or none (edit-stats doctrine).
 */

import { google } from 'googleapis';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { buildBotOAuthClient } from '../workspace';

const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/directory.readonly';

/**
 * Resolve a set of actor resources to emails. Returns a map that has an
 * entry for EVERY input: resolved email, or the raw resource name when
 * resolution fails. DB cache first; People API for misses; new
 * successes are cached for the next run. The synthetic '(unattributed)'
 * actor passes through untouched.
 */
export async function resolveActors(
  resources: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const pending: string[] = [];

  for (const r of resources) {
    if (!r.startsWith('people/')) {
      out.set(r, r); // '(unattributed)' and any non-people actor
      continue;
    }
    pending.push(r);
  }
  if (pending.length === 0) return out;

  const cached = await prisma.peopleResourceMap.findMany({
    where: { personResource: { in: pending } },
  });
  const cachedBy = new Map(cached.map((c) => [c.personResource, c]));
  const misses: string[] = [];
  for (const r of pending) {
    const hit = cachedBy.get(r);
    if (hit?.email) out.set(r, hit.email);
    else misses.push(r);
  }
  if (misses.length === 0) return out;

  const auth = await buildBotOAuthClient('directory', [DIRECTORY_SCOPE]);
  const people = google.people({ version: 'v1', auth });

  let resolved = 0;
  for (const resource of misses) {
    try {
      const res = await people.people.get({
        resourceName: resource,
        personFields: 'emailAddresses,names',
        sources: ['READ_SOURCE_TYPE_DOMAIN_PROFILE', 'READ_SOURCE_TYPE_PROFILE'],
      });
      const email =
        res.data.emailAddresses?.find((e) => e.metadata?.primary)?.value ??
        res.data.emailAddresses?.[0]?.value ??
        null;
      const displayName = res.data.names?.[0]?.displayName ?? null;
      if (email) {
        await prisma.peopleResourceMap.upsert({
          where: { personResource: resource },
          create: { personResource: resource, email, displayName },
          update: { email, displayName, resolvedAt: new Date() },
        });
        out.set(resource, email);
        resolved++;
      } else {
        out.set(resource, resource);
      }
    } catch (err) {
      // Miss (deleted user, external actor, permission shape) — keep the
      // raw resource; next run retries. Never drop the actor.
      logger.warn(
        { resource, err: err instanceof Error ? err.message : String(err) },
        '[forward.people] resolution failed — keeping raw resource',
      );
      out.set(resource, resource);
    }
  }
  logger.info(
    { requested: resources.size, cacheHits: pending.length - misses.length, resolved, unresolved: misses.length - resolved },
    '[forward.people] actor resolution complete',
  );
  return out;
}
