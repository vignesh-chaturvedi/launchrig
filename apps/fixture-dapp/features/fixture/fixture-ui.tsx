import type { ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export function FixtureScreen({
  children,
  description,
  title,
}: {
  children: ReactNode
  description: string
  title: string
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>LaunchRig mobile fixture</Text>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  )
}

export function FixtureStatusCard({ children }: { children: ReactNode }) {
  return <View style={styles.statusCard}>{children}</View>
}

export function FixtureStatusRow({ label, testID, value }: { label: string; testID?: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue} testID={testID}>
        {value}
      </Text>
    </View>
  )
}

export function FixtureButton({
  disabled,
  onPress,
  testID,
  title,
}: {
  disabled: boolean
  onPress: () => void
  testID: string
  title: string
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled ? styles.buttonDisabled : null,
        pressed && !disabled ? styles.buttonPressed : null,
      ]}
      testID={testID}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  )
}

export function FixtureMessage({
  children,
  status,
}: {
  children: ReactNode
  status: 'danger' | 'success'
}) {
  return <Text style={status === 'danger' ? styles.danger : styles.success}>{children}</Text>
}

export function InvalidFixtureScreen({ scenario }: { scenario: string }) {
  return (
    <FixtureScreen
      description="Open a controlled LaunchRig fixture link with an explicit broken or fixed variant."
      title="Invalid fixture link"
    >
      <FixtureStatusCard>
        <FixtureStatusRow label="Fixture ready" testID="fixture-ready" value="NOT_READY" />
        <FixtureStatusRow label="Scenario" testID="fixture-scenario" value={scenario} />
        <FixtureStatusRow label="Variant" testID="fixture-variant" value="INVALID" />
      </FixtureStatusCard>
      <FixtureMessage status="danger">The fixture variant must be broken or fixed.</FixtureMessage>
    </FixtureScreen>
  )
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#242424',
    borderRadius: 10,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  buttonDisabled: {
    backgroundColor: '#a8a8a8',
  },
  buttonPressed: {
    opacity: 0.75,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  content: {
    gap: 14,
    padding: 20,
  },
  danger: {
    color: '#9d1c13',
    fontSize: 14,
  },
  description: {
    color: '#444444',
    fontSize: 16,
    lineHeight: 23,
  },
  eyebrow: {
    color: '#5d5d5d',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  screen: {
    backgroundColor: '#f4f2ed',
    flex: 1,
  },
  statusCard: {
    backgroundColor: '#ffffff',
    borderColor: '#d7d3ca',
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
  },
  statusLabel: {
    color: '#5d5d5d',
    fontSize: 14,
  },
  statusRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  statusValue: {
    color: '#171717',
    fontFamily: 'monospace',
    fontSize: 14,
    fontWeight: '700',
  },
  success: {
    color: '#126b36',
    fontSize: 15,
    fontWeight: '700',
  },
  title: {
    color: '#171717',
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 36,
  },
})
