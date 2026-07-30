/**
 * workspace module — Google Workspace auth.
 *
 * Bot-OAuth runtime helper only — this Job has no user-tier (per-request
 * pass-through) needs. The full GUB workspace module also exposes
 * `resolveWorkspaceCreds` / `buildGoogleAuthClient` for user-facing
 * endpoints; we don't port them.
 */
export {
  buildBotOAuthClient,
  type BotName,
  BotCredentialsMissingError,
  BotCredentialsScopeMismatchError,
  BotCredentialsConfigError,
} from './bot-creds';
