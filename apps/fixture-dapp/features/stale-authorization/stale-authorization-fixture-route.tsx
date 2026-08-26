import { useLocalSearchParams } from 'expo-router'
import { parseFixtureVariant } from '@/features/fixture/fixture-variant'
import { InvalidFixtureScreen } from '@/features/fixture/fixture-ui'
import { StaleAuthorizationFixture } from '@/features/stale-authorization/stale-authorization-fixture'

export function StaleAuthorizationFixtureRoute() {
  const { variant } = useLocalSearchParams<{ variant?: string | string[] }>()
  const fixtureVariant = parseFixtureVariant(variant)

  if (!fixtureVariant) {
    return <InvalidFixtureScreen scenario="stale-authorization" />
  }

  return <StaleAuthorizationFixture key={fixtureVariant} variant={fixtureVariant} />
}
