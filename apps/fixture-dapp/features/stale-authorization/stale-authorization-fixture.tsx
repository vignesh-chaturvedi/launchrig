import { useState } from 'react'
import { transact, useMobileWallet } from '@wallet-ui/react-native-kit'
import type { FixtureVariant } from '@/features/fixture/fixture-variant'
import {
  FixtureButton,
  FixtureMessage,
  FixtureScreen,
  FixtureStatusCard,
  FixtureStatusRow,
} from '@/features/fixture/fixture-ui'

type RecoveryState =
  | 'AUTHORIZATION_CLEARED'
  | 'IDLE'
  | 'INVALIDATING'
  | 'RECONNECTED'
  | 'REQUEST_COMPLETED'
  | 'REQUEST_FAILED'
  | 'STALE_TOKEN'
  | 'WAITING'

type FixtureNotice = { status: 'danger' | 'success'; text: string }

export function StaleAuthorizationFixture({ variant }: { variant: FixtureVariant }) {
  const { account, chain, connect, identity, store } = useMobileWallet()
  const [connectPending, setConnectPending] = useState(false)
  const [seedPending, setSeedPending] = useState(false)
  const [staleAuthSeeded, setStaleAuthSeeded] = useState(false)
  const [reauthorizationPending, setReauthorizationPending] = useState(false)
  const [recoveryState, setRecoveryState] = useState<RecoveryState>('IDLE')
  const [notice, setNotice] = useState<FixtureNotice | null>(null)

  const anyActionPending = connectPending || seedPending || reauthorizationPending
  const seedActionEnabled = Boolean(account) && !staleAuthSeeded && !anyActionPending
  const reauthorizationActionEnabled = Boolean(account) && staleAuthSeeded && !anyActionPending
  const reconnectEnabled = !account && !anyActionPending

  async function connectWallet() {
    if (!reconnectEnabled) {
      return
    }

    setConnectPending(true)
    setNotice(null)
    try {
      await connect()
      if (recoveryState === 'AUTHORIZATION_CLEARED') {
        setStaleAuthSeeded(false)
        setRecoveryState('RECONNECTED')
        setNotice({ status: 'success', text: 'Wallet authorization was renewed.' })
      }
    } catch {
      setNotice({ status: 'danger', text: 'Wallet connection failed.' })
    } finally {
      setConnectPending(false)
    }
  }

  async function seedStaleAuthorization() {
    if (!seedActionEnabled) {
      return
    }

    const authToken = store.$authToken.get()
    if (!authToken) {
      setRecoveryState('REQUEST_FAILED')
      setNotice({ status: 'danger', text: 'No cached wallet authorization is available.' })
      return
    }

    setSeedPending(true)
    setRecoveryState('INVALIDATING')
    setNotice(null)
    try {
      await transact(async (wallet) => {
        await wallet.deauthorize({ auth_token: authToken })
      })
      setStaleAuthSeeded(true)
      setRecoveryState('STALE_TOKEN')
    } catch {
      setRecoveryState('REQUEST_FAILED')
      setNotice({ status: 'danger', text: 'Wallet authorization could not be invalidated.' })
    } finally {
      setSeedPending(false)
    }
  }

  async function requestReauthorization() {
    if (!reauthorizationActionEnabled) {
      return
    }

    const authToken = store.$authToken.get()
    if (!authToken) {
      setRecoveryState('REQUEST_FAILED')
      setNotice({ status: 'danger', text: 'No cached wallet authorization is available.' })
      return
    }

    setReauthorizationPending(true)
    setRecoveryState('WAITING')
    setNotice(null)

    try {
      await transact(async (wallet) => {
        await wallet.authorize({ auth_token: authToken, chain, identity })
      })
      setRecoveryState('REQUEST_COMPLETED')
      setReauthorizationPending(false)
    } catch (error) {
      if (isAuthorizationFailedError(error)) {
        if (variant === 'broken') {
          return
        }

        try {
          await store.persist(null)
        } catch {
          setRecoveryState('REQUEST_FAILED')
          setReauthorizationPending(false)
          setNotice({ status: 'danger', text: 'Cached wallet authorization could not be cleared.' })
          return
        }

        setRecoveryState('AUTHORIZATION_CLEARED')
        setReauthorizationPending(false)
        setNotice({ status: 'success', text: 'Stale authorization cleared. Reconnect the wallet.' })
        return
      }

      setRecoveryState('REQUEST_FAILED')
      setReauthorizationPending(false)
      setNotice({ status: 'danger', text: 'Wallet reauthorization failed.' })
    }
  }

  return (
    <FixtureScreen
      description="Revoke a cached devnet wallet authorization, reuse it, then verify that the app clears the stale session."
      title="Stale authorization recovery"
    >
      <FixtureStatusCard>
        <FixtureStatusRow label="Fixture ready" testID="fixture-ready" value="READY" />
        <FixtureStatusRow label="Scenario" testID="fixture-scenario" value="stale-authorization" />
        <FixtureStatusRow label="Variant" testID="fixture-variant" value={variant} />
        <FixtureStatusRow label="Network" value="DEVNET" />
        <FixtureStatusRow label="Wallet" testID="wallet-state" value={account ? 'CONNECTED' : 'DISCONNECTED'} />
        <FixtureStatusRow label="Stale auth seeded" testID="stale-auth-seeded" value={String(staleAuthSeeded)} />
        <FixtureStatusRow
          label="Reauthorization pending"
          testID="reauthorization-pending"
          value={String(reauthorizationPending)}
        />
        <FixtureStatusRow label="Recovery" testID="stale-auth-recovered" value={recoveryState} />
        <FixtureStatusRow label="Seed enabled" testID="seed-action-enabled" value={String(seedActionEnabled)} />
        <FixtureStatusRow
          label="Reauthorization enabled"
          testID="reauthorization-action-enabled"
          value={String(reauthorizationActionEnabled)}
        />
        <FixtureStatusRow label="Reconnect enabled" testID="reconnect-enabled" value={String(reconnectEnabled)} />
      </FixtureStatusCard>

      <FixtureButton
        disabled={!reconnectEnabled}
        onPress={() => void connectWallet()}
        testID="connect-wallet"
        title={
          connectPending
            ? 'Connecting wallet'
            : recoveryState === 'AUTHORIZATION_CLEARED'
              ? 'Reconnect wallet'
              : 'Connect wallet'
        }
      />
      <FixtureButton
        disabled={!seedActionEnabled}
        onPress={() => void seedStaleAuthorization()}
        testID="seed-stale-authorization"
        title={seedPending ? 'Invalidating authorization' : 'Seed stale authorization'}
      />
      <FixtureButton
        disabled={!reauthorizationActionEnabled}
        onPress={() => void requestReauthorization()}
        testID="request-reauthorization"
        title={reauthorizationPending ? 'Waiting for wallet' : 'Use cached authorization'}
      />

      {notice ? <FixtureMessage status={notice.status}>{notice.text}</FixtureMessage> : null}
    </FixtureScreen>
  )
}

export function isAuthorizationFailedError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const code = String(record?.code ?? record?.errorCode ?? '').toUpperCase()
  const message = error instanceof Error ? error.message.toUpperCase() : String(error ?? '').toUpperCase()

  if (code === '-1') {
    return true
  }

  return code.includes('ERROR_AUTHORIZATION_FAILED') || message.includes('ERROR_AUTHORIZATION_FAILED')
}
