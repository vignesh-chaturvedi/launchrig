import { useEffect, useState } from 'react'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import {
  FixtureButton,
  FixtureMessage,
  FixtureScreen,
  FixtureStatusCard,
  FixtureStatusRow,
} from '@/features/fixture/fixture-ui'
import type { FixtureVariant } from '@/features/fixture/fixture-variant'
import {
  createProcessInstance,
  readProcessDeathJournal,
  repairProcessDeathJournal,
  writeProcessDeathJournal,
  type ProcessDeathJournal,
  type ProcessDeathPhase,
} from '@/features/process-death/process-death-journal'

type RequestOutcome = 'FAILED' | 'NONE' | 'SIGNED' | 'UNKNOWN' | 'USER_REJECTED'
type FixtureReady = 'HYDRATING' | 'READY' | 'REPAIR_REQUIRED'

const PROCESS_INSTANCE = createProcessInstance()

export function ProcessDeathFixture({ variant }: { variant: FixtureVariant }) {
  const { account, connect, signMessages } = useMobileWallet()
  const [fixtureReady, setFixtureReady] = useState<FixtureReady>('HYDRATING')
  const [connectPending, setConnectPending] = useState(false)
  const [requestPending, setRequestPending] = useState(false)
  const [processInstanceChanged, setProcessInstanceChanged] = useState(false)
  const [processDeathState, setProcessDeathState] = useState<'IDLE' | ProcessDeathPhase>('IDLE')
  const [requestOutcome, setRequestOutcome] = useState<RequestOutcome>('NONE')
  const [notice, setNotice] = useState<{ status: 'danger' | 'success'; text: string } | null>(null)

  const requestActionEnabled = fixtureReady === 'READY' && Boolean(account) && !requestPending

  useEffect(() => {
    let active = true

    async function hydrate() {
      try {
        const result = await readProcessDeathJournal()
        if (!active) {
          return
        }

        if (result.status === 'ABSENT') {
          setFixtureReady('READY')
          return
        }

        if (result.status === 'CORRUPT') {
          requireJournalRepair('The process-death journal is invalid and must be reset.')
          return
        }

        const journal = result.journal
        if (journal.variant !== variant) {
          requireJournalRepair('A journal from another fixture variant must be reset.')
          return
        }

        const changed = journal.originProcessInstance !== PROCESS_INSTANCE
        setProcessInstanceChanged(changed)

        if (!changed) {
          setProcessDeathState(journal.phase)
          setRequestPending(journal.phase === 'IN_FLIGHT')
          setRequestOutcome(journal.phase === 'RECOVERED_UNKNOWN' ? 'UNKNOWN' : 'NONE')
          setFixtureReady('READY')
          return
        }

        if (journal.phase === 'IN_FLIGHT' && variant === 'fixed') {
          const recovered: ProcessDeathJournal = { ...journal, phase: 'RECOVERED_UNKNOWN' }
          await writeProcessDeathJournal(recovered)
          if (!active) {
            return
          }
          setProcessDeathState('RECOVERED_UNKNOWN')
          setRequestPending(false)
          setRequestOutcome('UNKNOWN')
          setNotice({
            status: 'success',
            text: 'The interrupted request has an unknown outcome. Retry is available.',
          })
          setFixtureReady('READY')
          return
        }

        setProcessDeathState(journal.phase)
        setRequestPending(journal.phase === 'IN_FLIGHT')
        setRequestOutcome(journal.phase === 'RECOVERED_UNKNOWN' ? 'UNKNOWN' : 'NONE')
        setFixtureReady('READY')
      } catch {
        if (active) {
          requireJournalRepair('The process-death journal could not be loaded or recovered.')
        }
      }
    }

    function requireJournalRepair(text: string) {
      setFixtureReady('REPAIR_REQUIRED')
      setRequestPending(false)
      setNotice({ status: 'danger', text })
    }

    void hydrate()
    return () => {
      active = false
    }
  }, [variant])

  async function resetFixture() {
    if (requestPending && fixtureReady === 'READY') {
      return
    }

    try {
      await repairProcessDeathJournal()
      setProcessInstanceChanged(false)
      setProcessDeathState('IDLE')
      setRequestOutcome('NONE')
      setNotice(null)
      setFixtureReady('READY')
    } catch {
      setFixtureReady('REPAIR_REQUIRED')
      setNotice({ status: 'danger', text: 'The process-death journal could not be reset and verified.' })
    }
  }

  async function connectWallet() {
    if (account || connectPending || fixtureReady !== 'READY') {
      return
    }

    setConnectPending(true)
    setNotice(null)
    try {
      await connect()
    } catch {
      setNotice({ status: 'danger', text: 'Wallet connection failed.' })
    } finally {
      setConnectPending(false)
    }
  }

  async function requestProcessDeath() {
    if (!account || !requestActionEnabled) {
      return
    }

    const journal: ProcessDeathJournal = {
      schemaVersion: 1,
      variant,
      attemptId: createProcessInstance(),
      originProcessInstance: PROCESS_INSTANCE,
      phase: 'IN_FLIGHT',
    }

    setRequestPending(true)
    setProcessDeathState('IN_FLIGHT')
    setRequestOutcome('NONE')
    setNotice(null)

    try {
      await writeProcessDeathJournal(journal)
    } catch {
      setRequestPending(false)
      setRequestOutcome('FAILED')
      setFixtureReady('REPAIR_REQUIRED')
      setNotice({ status: 'danger', text: 'The request journal could not be saved. Reset is required.' })
      return
    }

    let outcome: RequestOutcome = 'SIGNED'
    let failureNotice: string | null = null
    try {
      await signMessages(new TextEncoder().encode(`LaunchRig process-death fixture for ${account.address}`))
    } catch (error) {
      if (isUserRejectedError(error)) {
        outcome = 'USER_REJECTED'
      } else {
        outcome = 'FAILED'
        failureNotice = 'Wallet request failed.'
      }
    }

    try {
      await repairProcessDeathJournal()
    } catch {
      setRequestPending(false)
      setRequestOutcome(outcome)
      setFixtureReady('REPAIR_REQUIRED')
      setNotice({ status: 'danger', text: 'The request journal could not be cleared. Reset is required.' })
      return
    }

    setProcessDeathState('IDLE')
    setRequestPending(false)
    setRequestOutcome(outcome)
    setNotice(failureNotice ? { status: 'danger', text: failureNotice } : null)
  }

  return (
    <FixtureScreen
      description="Kill the app while a wallet request is open, then verify that restart reports an unknown outcome and permits retry."
      title="Process-death recovery"
    >
      <FixtureStatusCard>
        <FixtureStatusRow label="Fixture ready" testID="fixture-ready" value={fixtureReady} />
        <FixtureStatusRow label="Scenario" testID="fixture-scenario" value="process-death" />
        <FixtureStatusRow label="Variant" testID="fixture-variant" value={variant} />
        <FixtureStatusRow label="Network" value="DEVNET" />
        <FixtureStatusRow label="Wallet" testID="wallet-state" value={account ? 'CONNECTED' : 'DISCONNECTED'} />
        <FixtureStatusRow
          label="Process changed"
          testID="process-instance-changed"
          value={String(processInstanceChanged)}
        />
        <FixtureStatusRow label="Recovery" testID="process-death-state" value={processDeathState} />
        <FixtureStatusRow label="Request outcome" testID="request-outcome" value={requestOutcome} />
        <FixtureStatusRow label="Request pending" testID="request-pending" value={String(requestPending)} />
        <FixtureStatusRow
          label="Request enabled"
          testID="request-action-enabled"
          value={String(requestActionEnabled)}
        />
      </FixtureStatusCard>

      <FixtureButton
        disabled={fixtureReady === 'HYDRATING' || (fixtureReady === 'READY' && requestPending)}
        onPress={() => void resetFixture()}
        testID="reset-process-death-fixture"
        title="Reset process-death fixture"
      />
      <FixtureButton
        disabled={Boolean(account) || connectPending || fixtureReady !== 'READY'}
        onPress={() => void connectWallet()}
        testID="connect-wallet"
        title={account ? 'Wallet connected' : connectPending ? 'Connecting wallet' : 'Connect wallet'}
      />
      <FixtureButton
        disabled={!requestActionEnabled}
        onPress={() => void requestProcessDeath()}
        testID="request-process-death"
        title={requestPending ? 'Waiting for wallet' : 'Request process-death test'}
      />

      {notice ? <FixtureMessage status={notice.status}>{notice.text}</FixtureMessage> : null}
    </FixtureScreen>
  )
}

function isUserRejectedError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const code = String(record?.code ?? record?.errorCode ?? '').toUpperCase()
  const message = error instanceof Error ? error.message.toUpperCase() : String(error ?? '').toUpperCase()
  return code === '-3' || code === '4001' || message.includes('USER_REJECTED') || message.includes('USER REJECTED')
}
