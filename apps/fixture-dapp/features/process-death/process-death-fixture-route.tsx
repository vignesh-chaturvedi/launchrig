import { useLocalSearchParams } from 'expo-router'
import { InvalidFixtureScreen } from '@/features/fixture/fixture-ui'
import { parseFixtureVariant } from '@/features/fixture/fixture-variant'
import { ProcessDeathFixture } from '@/features/process-death/process-death-fixture'

export function ProcessDeathFixtureRoute() {
  const { variant } = useLocalSearchParams<{ variant?: string | string[] }>()
  const fixtureVariant = parseFixtureVariant(variant)

  if (!fixtureVariant) {
    return <InvalidFixtureScreen scenario="process-death" />
  }

  return <ProcessDeathFixture key={fixtureVariant} variant={fixtureVariant} />
}
