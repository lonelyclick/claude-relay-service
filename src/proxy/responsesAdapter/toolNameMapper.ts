export interface NamespaceToolName {
  namespace: string
  name: string
}

export function flattenNamespaceToolName(namespace: string, name: string): string {
  const normalizedNamespace = namespace.endsWith('__') ? namespace : `${namespace}__`
  return `${normalizedNamespace}${name}`
}

export function splitFlattenedNamespaceToolName(name: string): NamespaceToolName | null {
  const match = /^(mcp__[A-Za-z0-9_-]+__)([A-Za-z0-9_-]+)$/.exec(name)
  if (!match) return null
  return {
    namespace: match[1]!,
    name: match[2]!,
  }
}
