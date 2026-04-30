export type DisplayOrganization = {
  id?: string
  name?: string | null
  slug?: string | null
  relayOrgId?: string | null
}

const clean = (value?: string | null) => value?.trim() || ''
const normalize = (value?: string | null) => clean(value).toLowerCase()

export function getOrganizationRelayId(org?: DisplayOrganization | null) {
  return clean(org?.relayOrgId) || clean(org?.slug) || clean(org?.name)
}

export function findOrganizationByRelayOrgId<T extends DisplayOrganization>(
  organizations: T[],
  relayOrgId?: string | null,
): T | null {
  const target = normalize(relayOrgId)
  if (!target) return null
  return organizations.find((org) => (
    normalize(org.relayOrgId) === target ||
    normalize(org.slug) === target ||
    normalize(org.name) === target
  )) ?? null
}

export function getOrganizationPrimaryLabel(org?: DisplayOrganization | null, fallback?: string | null) {
  return clean(org?.name) || getOrganizationRelayId(org) || clean(fallback) || '—'
}

export function getOrganizationSecondaryLabel(org?: DisplayOrganization | null) {
  const primary = getOrganizationPrimaryLabel(org)
  const relayOrgId = getOrganizationRelayId(org)
  if (relayOrgId && relayOrgId !== primary) return relayOrgId
  const slug = clean(org?.slug)
  if (slug && slug !== primary) return slug
  return null
}

export function formatOrganizationLabel(org?: DisplayOrganization | null, fallback?: string | null) {
  const primary = getOrganizationPrimaryLabel(org, fallback)
  const secondary = getOrganizationSecondaryLabel(org)
  return secondary ? `${primary} (${secondary})` : primary
}
