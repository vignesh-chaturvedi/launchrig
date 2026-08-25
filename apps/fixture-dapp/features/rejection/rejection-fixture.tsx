import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import type { FixtureVariant } from '@/features/rejection/fixture-variant'
import { formatError } from '@/utils/format-error'

type RecoveryState = 'IDLE' | 'REQUEST_COMPLETED' | 'REQUEST_FAILED' | 'USER_REJECTED' | 'WAITING'

export function RejectionFixture({ variant }: { variant: FixtureVariant }) {
  const { account, connect, signMessages } = useMobileWallet()
  const [connectPending, setConnectPending] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [requestPending, setRequestPending] = useState(false)
  const [recoveryState, setRecoveryState] = useState<RecoveryState>('IDLE')
  const [requestDetail, setRequestDetail] = useState<string | null>(null)

  const requestActionEnabled = Boolean(account) && !requestPending

  async function connectWallet() {
    if (account || connectPending) {
      return
    }

    setConnectPending(true)
    setConnectError(null)
    try {
      await connect()
    } catch (error) {
      setConnectError(formatError(error))
    } finally {
      setConnectPending(false)
    }
  }

  async function requestRejection() {
    if (!account || requestPending) {
      return
    }

    setRequestPending(true)
    setRecoveryState('WAITING')
    setRequestDetail(null)

    try {
      await signMessages(new TextEncoder().encode(`LaunchRig rejection fixture for ${account.address}`))
      setRecoveryState('REQUEST_COMPLETED')
      setRequestPending(false)
    } catch (error) {
      if (isUserRejectedError(error)) {
        if (variant === 'broken') {
          return
        }

        setRecoveryState('USER_REJECTED')
        setRequestPending(false)
        return
      }

      setRequestDetail(formatError(error))
      setRecoveryState('REQUEST_FAILED')
      setRequestPending(false)
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>LaunchRig mobile fixture</Text>
        <Text style={styles.title}>Wallet rejection recovery</Text>
        <Text style={styles.description}>
          Connect a devnet wallet, request a message signature, then reject the request in the wallet.
        </Text>

        <View style={styles.statusCard}>
          <StatusRow label="Fixture ready" testID="fixture-ready" value="READY" />
          <StatusRow label="Variant" testID="fixture-variant" value={variant} />
          <StatusRow label="Network" value="DEVNET" />
          <StatusRow label="Wallet" testID="wallet-state" value={account ? 'CONNECTED' : 'DISCONNECTED'} />
          <StatusRow label="Request pending" testID="request-pending" value={String(requestPending)} />
          <StatusRow label="Recovery" testID="rejection-recovered" value={recoveryState} />
          <StatusRow label="Retry enabled" testID="request-action-enabled" value={String(requestActionEnabled)} />
        </View>

        <FixtureButton
          disabled={Boolean(account) || connectPending}
          onPress={() => void connectWallet()}
          testID="connect-wallet"
          title={account ? 'Wallet connected' : connectPending ? 'Connecting wallet' : 'Connect wallet'}
        />
        <FixtureButton
          disabled={!requestActionEnabled}
          onPress={() => void requestRejection()}
          testID="request-rejection"
          title={requestPending ? 'Waiting for wallet' : 'Request rejection'}
        />

        {connectError ? <Text style={styles.error}>Wallet connection failed: {connectError}</Text> : null}
        {requestDetail ? <Text style={styles.error}>Wallet request failed: {requestDetail}</Text> : null}
        {recoveryState === 'USER_REJECTED' ? (
          <Text style={styles.recovered}>USER_REJECTED: request state cleared, retry is enabled.</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function StatusRow({ label, testID, value }: { label: string; testID?: string; value: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={styles.statusValue} testID={testID}>
        {value}
      </Text>
    </View>
  )
}

function FixtureButton({
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

export function isUserRejectedError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const code = String(record?.code ?? record?.errorCode ?? '').toUpperCase()
  const message = formatError(error).toUpperCase()

  if (code === '-3' || code === '4001') {
    return true
  }

  const rejectionTokens = ['ERROR_NOT_SIGNED', 'USER_REJECTED', 'USER REJECTED', 'USER_DECLINED', 'USER DECLINED']
  return rejectionTokens.some((token) => code.includes(token) || message.includes(token))
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#242424',
    borderRadius: 10,
    minHeight: 48,
    justifyContent: 'center',
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
  description: {
    color: '#444444',
    fontSize: 16,
    lineHeight: 23,
  },
  error: {
    color: '#9d1c13',
    fontSize: 14,
  },
  eyebrow: {
    color: '#5d5d5d',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  recovered: {
    color: '#126b36',
    fontSize: 15,
    fontWeight: '700',
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
  title: {
    color: '#171717',
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 36,
  },
})
