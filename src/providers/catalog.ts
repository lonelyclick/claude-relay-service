import type { AccountProvider, AuthMode, ProtocolKind } from '../types.js'

export type ProviderProfile = {
  id: AccountProvider
  protocol: ProtocolKind
  authMode: AuthMode
  displayName: string
}

export const CLAUDE_OFFICIAL_PROVIDER: ProviderProfile = {
  id: 'claude-official',
  protocol: 'claude',
  authMode: 'oauth',
  displayName: 'Claude Official',
}

export const OPENAI_CODEX_PROVIDER: ProviderProfile = {
  id: 'openai-codex',
  protocol: 'openai',
  authMode: 'oauth',
  displayName: 'OpenAI Codex',
}

export const OPENAI_COMPATIBLE_PROVIDER: ProviderProfile = {
  id: 'openai-compatible',
  protocol: 'openai',
  authMode: 'api_key',
  displayName: 'OpenAI Compatible',
}

export const CLAUDE_COMPATIBLE_PROVIDER: ProviderProfile = {
  id: 'claude-compatible',
  protocol: 'claude',
  authMode: 'api_key',
  displayName: 'Claude Compatible',
}

export const GOOGLE_GEMINI_OAUTH_PROVIDER: ProviderProfile = {
  id: 'google-gemini-oauth',
  protocol: 'openai',
  authMode: 'oauth',
  displayName: 'Google Gemini (OAuth)',
}

const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  CLAUDE_OFFICIAL_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  OPENAI_COMPATIBLE_PROVIDER,
  CLAUDE_COMPATIBLE_PROVIDER,
  GOOGLE_GEMINI_OAUTH_PROVIDER,
]

const PROVIDER_PROFILE_MAP = new Map(
  PROVIDER_PROFILES.map((profile) => [profile.id, profile] as const),
)

export function listProviderProfiles(): readonly ProviderProfile[] {
  return PROVIDER_PROFILES
}

export function isKnownProviderId(value: string): value is AccountProvider {
  return PROVIDER_PROFILE_MAP.has(value as AccountProvider)
}

export function getProviderProfile(provider: AccountProvider): ProviderProfile {
  return PROVIDER_PROFILE_MAP.get(provider) ?? CLAUDE_OFFICIAL_PROVIDER
}

export function resolveProviderProfile(provider: string | null | undefined): ProviderProfile {
  if (provider && isKnownProviderId(provider)) {
    return getProviderProfile(provider)
  }
  return CLAUDE_OFFICIAL_PROVIDER
}

export function providerRequiresProxy(provider: AccountProvider): boolean {
  return provider === CLAUDE_OFFICIAL_PROVIDER.id
}
