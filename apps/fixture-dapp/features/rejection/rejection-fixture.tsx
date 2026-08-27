import { useState } from 'react'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import {
  FixtureButton,
  FixtureMessage,
  FixtureScreen,
  FixtureStatusCard,
  FixtureStatusRow,
} from '@/features/fixture/fixture-ui'
import type { FixtureVariant } from '@/features/fixture/fixture-variant'
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
    <FixtureScreen
      description="Connect a devnet wallet, request a message signature, then reject the request in the wallet."
      title="Wallet rejection recovery"
    >
      <FixtureStatusCard>
        <FixtureStatusRow label="Fixture ready" testID="fixture-ready" value="READY" />
        <FixtureStatusRow label="Scenario" testID="fixture-scenario" value="rejection-recovery" />
        <FixtureStatusRow label="Variant" testID="fixture-variant" value={variant} />
        <FixtureStatusRow label="Network" value="DEVNET" />
        <FixtureStatusRow label="Wallet" testID="wallet-state" value={account ? 'CONNECTED' : 'DISCONNECTED'} />
        <FixtureStatusRow label="Request pending" testID="request-pending" value={String(requestPending)} />
        <FixtureStatusRow label="Recovery" testID="rejection-recovered" value={recoveryState} />
        <FixtureStatusRow label="Retry enabled" testID="request-action-enabled" value={String(requestActionEnabled)} />
      </FixtureStatusCard>

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

      {connectError ? <FixtureMessage status="danger">Wallet connection failed: {connectError}</FixtureMessage> : null}
      {requestDetail ? <FixtureMessage status="danger">Wallet request failed: {requestDetail}</FixtureMessage> : null}
      {recoveryState === 'USER_REJECTED' ? (
        <FixtureMessage status="success">USER_REJECTED: request state cleared, retry is enabled.</FixtureMessage>
      ) : null}
    </FixtureScreen>
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
