import { useLocalSearchParams } from 'expo-router'
import { parseFixtureVariant } from '@/features/rejection/fixture-variant'
import { RejectionFixture } from '@/features/rejection/rejection-fixture'

export function RejectionFixtureRoute() {
  const { variant } = useLocalSearchParams<{ variant?: string | string[] }>()
  const fixtureVariant = parseFixtureVariant(variant)

  return <RejectionFixture key={fixtureVariant} variant={fixtureVariant} />
}
