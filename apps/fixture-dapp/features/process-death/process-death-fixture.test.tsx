import { fireEvent, render, waitFor } from '@testing-library/react-native'
import type { Address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessDeathFixture } from '@/features/process-death/process-death-fixture'
import { PROCESS_DEATH_JOURNAL_KEY } from '@/features/process-death/process-death-journal'

const TEST_ADDRESS = 'GsbwXfJraMomNxBcjK9jJ3YuPBQTd7pTvbwEfJvvZoP1' as Address
const PRIVATE_ATTEMPT = 'private-attempt-id'
const PRIVATE_PROCESS = 'previous-private-process'

const fixture = vi.hoisted(() => ({
  storage: {
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  },
  wallet: {
    current: {
      account: { address: 'GsbwXfJraMomNxBcjK9jJ3YuPBQTd7pTvbwEfJvvZoP1', label: 'Test Wallet' } as
        | { address: string; label: string }
        | undefined,
      connect: vi.fn(),
      signMessages: vi.fn(),
    },
  },
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: fixture.storage,
}))

vi.mock('@wallet-ui/react-native-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wallet-ui/react-native-kit')>()),
  useMobileWallet: () => fixture.wallet.current,
}))

function journal(variant: 'broken' | 'fixed', phase: 'IN_FLIGHT' | 'RECOVERED_UNKNOWN' = 'IN_FLIGHT') {
  return JSON.stringify({
    schemaVersion: 1,
    variant,
    attemptId: PRIVATE_ATTEMPT,
    originProcessInstance: PRIVATE_PROCESS,
    phase,
  })
}

function value(screen: Awaited<ReturnType<typeof render>>, testID: string) {
  return screen.getByTestId(testID).props.children
}

describe('ProcessDeathFixture', () => {
  beforeEach(() => {
    fixture.wallet.current.account = { address: TEST_ADDRESS, label: 'Test Wallet' }
    fixture.wallet.current.connect.mockReset()
    fixture.wallet.current.signMessages.mockReset()
    fixture.storage.getItem.mockReset().mockResolvedValue(null)
    fixture.storage.removeItem.mockReset().mockResolvedValue(undefined)
    fixture.storage.setItem.mockReset().mockResolvedValue(undefined)
  })

  it('keeps an interrupted request pending in broken mode', async () => {
    fixture.storage.getItem.mockResolvedValueOnce(journal('broken'))
    const screen = await render(<ProcessDeathFixture variant="broken" />)

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('READY'))
    expect(value(screen, 'fixture-scenario')).toBe('process-death')
    expect(value(screen, 'process-instance-changed')).toBe('true')
    expect(value(screen, 'process-death-state')).toBe('IN_FLIGHT')
    expect(value(screen, 'request-outcome')).toBe('NONE')
    expect(value(screen, 'request-pending')).toBe('true')
    expect(value(screen, 'request-action-enabled')).toBe('false')
    expect(fixture.storage.setItem).not.toHaveBeenCalled()
    expect(JSON.stringify(screen.toJSON())).not.toContain(PRIVATE_ATTEMPT)
    expect(JSON.stringify(screen.toJSON())).not.toContain(PRIVATE_PROCESS)
  })

  it('marks an interrupted request unknown and enables retry in fixed mode', async () => {
    fixture.storage.getItem.mockResolvedValueOnce(journal('fixed'))
    const screen = await render(<ProcessDeathFixture variant="fixed" />)

    await waitFor(() => expect(value(screen, 'process-death-state')).toBe('RECOVERED_UNKNOWN'))
    expect(value(screen, 'fixture-ready')).toBe('READY')
    expect(value(screen, 'process-instance-changed')).toBe('true')
    expect(value(screen, 'request-outcome')).toBe('UNKNOWN')
    expect(value(screen, 'request-pending')).toBe('false')
    expect(value(screen, 'request-action-enabled')).toBe('true')
    expect(screen.getByTestId('request-process-death').props.accessibilityState).toEqual({ disabled: false })
    expect(fixture.storage.setItem).toHaveBeenCalledWith(
      PROCESS_DEATH_JOURNAL_KEY,
      expect.stringContaining('"phase":"RECOVERED_UNKNOWN"'),
    )
    expect(JSON.stringify(screen.toJSON())).not.toContain(PRIVATE_ATTEMPT)
    expect(JSON.stringify(screen.toJSON())).not.toContain(PRIVATE_PROCESS)
  })

  it('persists the in-flight journal before opening the wallet request', async () => {
    fixture.wallet.current.signMessages.mockResolvedValueOnce([new Uint8Array([1, 2, 3])])
    const screen = await render(<ProcessDeathFixture variant="fixed" />)
    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('READY'))

    await fireEvent.press(screen.getByTestId('request-process-death'))

    expect(fixture.storage.setItem).toHaveBeenCalledOnce()
    expect(fixture.storage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.wallet.current.signMessages.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    )
    expect(fixture.storage.removeItem).toHaveBeenCalledWith(PROCESS_DEATH_JOURNAL_KEY)
    expect(fixture.storage.getItem).toHaveBeenCalledTimes(2)
    expect(value(screen, 'request-outcome')).toBe('SIGNED')
    expect(value(screen, 'request-pending')).toBe('false')
  })

  it('resets only the namespaced process-death journal', async () => {
    const screen = await render(<ProcessDeathFixture variant="fixed" />)
    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('READY'))

    await fireEvent.press(screen.getByTestId('reset-process-death-fixture'))

    expect(fixture.storage.removeItem).toHaveBeenCalledWith(PROCESS_DEATH_JOURNAL_KEY)
    expect(fixture.storage.getItem).toHaveBeenCalledTimes(2)
    expect(value(screen, 'process-death-state')).toBe('IDLE')
    expect(value(screen, 'request-outcome')).toBe('NONE')
  })

  it('blocks requests for a corrupt journal until verified repair succeeds', async () => {
    fixture.storage.getItem.mockResolvedValueOnce('{broken-json').mockResolvedValueOnce(null)
    const screen = await render(<ProcessDeathFixture variant="fixed" />)

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))
    expect(value(screen, 'request-action-enabled')).toBe('false')
    expect(screen.getByTestId('request-process-death').props.accessibilityState).toEqual({ disabled: true })

    await fireEvent.press(screen.getByTestId('reset-process-death-fixture'))

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('READY'))
    expect(fixture.storage.removeItem).toHaveBeenCalledWith(PROCESS_DEATH_JOURNAL_KEY)
    expect(value(screen, 'request-action-enabled')).toBe('true')
  })

  it('blocks requests when the journal cannot be read', async () => {
    fixture.storage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))
    const screen = await render(<ProcessDeathFixture variant="fixed" />)

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))
    expect(value(screen, 'request-action-enabled')).toBe('false')
    expect(fixture.wallet.current.signMessages).not.toHaveBeenCalled()
  })

  it('blocks requests when interrupted-request recovery cannot be persisted', async () => {
    fixture.storage.getItem.mockResolvedValueOnce(journal('fixed'))
    fixture.storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'))
    const screen = await render(<ProcessDeathFixture variant="fixed" />)

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))
    expect(value(screen, 'process-death-state')).toBe('IDLE')
    expect(value(screen, 'request-action-enabled')).toBe('false')
    expect(fixture.wallet.current.signMessages).not.toHaveBeenCalled()
  })

  it('does not open the wallet when the in-flight journal cannot be saved', async () => {
    fixture.storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'))
    const screen = await render(<ProcessDeathFixture variant="fixed" />)
    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('READY'))

    await fireEvent.press(screen.getByTestId('request-process-death'))

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))
    expect(fixture.wallet.current.signMessages).not.toHaveBeenCalled()
    expect(value(screen, 'request-action-enabled')).toBe('false')
  })

  it('keeps requests blocked when repair cannot be verified', async () => {
    fixture.storage.getItem.mockResolvedValueOnce('{broken-json')
    fixture.storage.removeItem.mockRejectedValueOnce(new Error('storage unavailable'))
    const screen = await render(<ProcessDeathFixture variant="fixed" />)
    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))

    await fireEvent.press(screen.getByTestId('reset-process-death-fixture'))

    await waitFor(() => expect(value(screen, 'fixture-ready')).toBe('REPAIR_REQUIRED'))
    expect(value(screen, 'request-action-enabled')).toBe('false')
  })
})
