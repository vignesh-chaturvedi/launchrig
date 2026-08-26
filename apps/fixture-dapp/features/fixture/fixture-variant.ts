export type FixtureVariant = 'broken' | 'fixed'

export function parseFixtureVariant(value: string | string[] | undefined): FixtureVariant | null {
  const candidate = Array.isArray(value) ? value[0] : value

  if (candidate === 'broken' || candidate === 'fixed') {
    return candidate
  }

  return null
}
