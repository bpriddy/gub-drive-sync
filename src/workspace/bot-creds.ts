/**
 * bot-creds.ts — Runtime helper for unattended Workspace syncs.
 *
 * Drive bot's refresh token lives in `bot_credentials` (written by gub-
 * admin's Settings → Sync Credentials consent flow). Here at runtime we
 * mint short-lived access tokens from it on demand. No SA, no DWD, no
 * impersonation chain.
 *
 * Threat model: a leaked SA key (the DWD model we rejected) could
 * impersonate any user in the domain for the granted scopes. A leaked
 * refresh token here can only access what the bot user has actually been
 * shared on.
 *
 * Caller usage:
 *
 *   const auth = await buildBotOAuthClient('drive', [
 *     'https://www.googleapis.com/auth/drive.readonly',
 *   ]);
 *   const drive = google.drive({ version: 'v3', auth });
 *
 * Errors are typed (BotCredentialsMissingError, BotCredentialsScopeMismatchError,
 * BotCredentialsConfigError) so callers can distinguish "bot was never
 * authorized" (admin needs to act) from "we asked for a scope the bot
 * doesn't have" (developer error) from "env isn't set up for the bot-
 * OAuth flow at all" (operator misconfiguration).
 *
 * Ported from gcp-universal-backend/src/modules/workspace/bot-creds.ts —
 * read-side only. The write side (start-authorize, oauth-callback,
 * smoke test, Settings UI) lives entirely in gub-admin.
 */

// IMPORTANT: import OAuth2 from `googleapis`, not `google-auth-library`. Both
// expose an OAuth2Client class, but `googleapis` re-exports its own pinned
// version under `google.auth.OAuth2`. Passing an instance of the wrong one
// to `google.drive({ version: 'v3', auth })` (and friends) results in
// googleapis NOT recognizing it as an auth client — it silently sends the
// request with no Authorization header and gets a 403 "unregistered
// callers" back. Single source of truth: googleapis's namespace.
import { google, type Auth } from 'googleapis';
import { prisma } from '../prisma';
import { config } from '../config';
import { logger } from '../logger';

type OAuth2Client = Auth.OAuth2Client;

/**
 * The closed set of bot identities. Mirrored in the migration's CHECK
 * constraint. Adding a new bot is a deliberate code+migration change —
 * not a runtime config knob.
 */
export type BotName = 'directory' | 'drive' | 'groups';

const KNOWN_BOTS: ReadonlySet<BotName> = new Set<BotName>(['directory', 'drive', 'groups']);

export function isKnownBot(name: string): name is BotName {
  return KNOWN_BOTS.has(name as BotName);
}

// ── Errors ───────────────────────────────────────────────────────────────────

export class BotCredentialsMissingError extends Error {
  readonly code = 'BOT_CREDENTIALS_MISSING';
  readonly httpStatus = 503;
  readonly botName: BotName;
  constructor(botName: BotName) {
    super(
      `Bot '${botName}' has not been authorized. Visit gub-admin Settings → ` +
        `Sync Credentials → click Authorize on the ${botName} row.`,
    );
    this.name = 'BotCredentialsMissingError';
    this.botName = botName;
  }
}

export class BotCredentialsScopeMismatchError extends Error {
  readonly code = 'BOT_CREDENTIALS_SCOPE_MISMATCH';
  readonly httpStatus = 500;
  readonly botName: BotName;
  readonly missingScope: string;
  readonly grantedScopes: readonly string[];
  constructor(botName: BotName, missingScope: string, grantedScopes: readonly string[]) {
    super(
      `Bot '${botName}' has not consented to scope '${missingScope}'. ` +
        `Granted scopes: [${grantedScopes.join(', ')}]. Re-authorize the bot ` +
        `with the new scope, or remove the scope from this caller.`,
    );
    this.name = 'BotCredentialsScopeMismatchError';
    this.botName = botName;
    this.missingScope = missingScope;
    this.grantedScopes = grantedScopes;
  }
}

export class BotCredentialsConfigError extends Error {
  readonly code = 'BOT_CREDENTIALS_CONFIG_MISSING';
  readonly httpStatus = 500;
  constructor() {
    super(
      'Bot-OAuth client is not configured. Set GUB_BOT_OAUTH_CLIENT_ID and ' +
        'GUB_BOT_OAUTH_CLIENT_SECRET in the environment.',
    );
    this.name = 'BotCredentialsConfigError';
  }
}

/**
 * Build a googleapis-compatible OAuth2Client for the named bot, ready to
 * mint access tokens from the stored refresh token.
 */
export async function buildBotOAuthClient(
  botName: BotName,
  scopes: string[],
): Promise<OAuth2Client> {
  if (!config.GUB_BOT_OAUTH_CLIENT_ID || !config.GUB_BOT_OAUTH_CLIENT_SECRET) {
    throw new BotCredentialsConfigError();
  }

  const row = await prisma.botCredential.findUnique({
    where: { botName },
  });
  if (!row) {
    throw new BotCredentialsMissingError(botName);
  }

  // Defensive scope-subset check. Google would return a 403 at API call
  // time if we asked for a scope the token doesn't carry, but throwing
  // here surfaces the problem at a sensible place in the call chain.
  for (const requestedScope of scopes) {
    if (!row.scopes.includes(requestedScope)) {
      throw new BotCredentialsScopeMismatchError(
        botName,
        requestedScope,
        row.scopes,
      );
    }
  }

  const client = new google.auth.OAuth2({
    clientId: config.GUB_BOT_OAUTH_CLIENT_ID,
    clientSecret: config.GUB_BOT_OAUTH_CLIENT_SECRET,
  });
  client.setCredentials({ refresh_token: row.refreshToken });

  // Best-effort last_used_at bump. Don't block on this.
  void prisma.botCredential
    .update({
      where: { botName },
      data: { lastUsedAt: new Date() },
    })
    .catch((err) => {
      logger.debug(
        { botName, err: String(err) },
        '[bot-creds] last_used_at bump failed (best-effort, non-blocking)',
      );
    });

  return client;
}
