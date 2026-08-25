import { fireEvent, render } from '@testing-library/react-native'
import type { Address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFixtureVariant } from '@/features/rejection/fixture-variant'
import { RejectionFixture } from '@/features/rejection/rejection-fixture'

const wallet = vi.hoisted(() => ({
  current: {
    account: null as { address: Address; label: string } | null,
    connect: vi.fn(),
    signMessages: vi.fn(),
  },
}))

vi.mock('@wallet-ui/react-native-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wallet-ui/react-native-kit')>()),
  useMobileWallet: () => wallet.current,
}))

const TEST_ADDRESS = 'GsbwXfJraMomNxBcjK9jJ3YuPBQTd7pTvbwEfJvvZoP1' as Address

describe('RejectionFixture', () => {
  beforeEach(() => {
    wallet.current.account = { address: TEST_ADDRESS, label: 'Test Wallet' }
    wallet.current.connect.mockReset()
    wallet.current.signMessages.mockReset()
  })

  it('defaults unknown deep-link variants to fixed mode', () => {
    expect(parseFixtureVariant(undefined)).toBe('fixed')
    expect(parseFixtureVariant('anything-else')).toBe('fixed')
    expect(parseFixtureVariant(['broken', 'fixed'])).toBe('broken')
  })

  it('exposes the stable fixture contract in fixed mode', async () => {
    const screen = await render(<RejectionFixture variant="fixed" />)

    expect(screen.getByTestId('fixture-ready').props.children).toBe('READY')
    expect(screen.getByTestId('fixture-variant').props.children).toBe('fixed')
    expect(screen.getByTestId('wallet-state').props.children).toBe('CONNECTED')
    expect(screen.getByTestId('request-pending').props.children).toBe('false')
    expect(screen.getByTestId('rejection-recovered').props.children).toBe('IDLE')
    expect(screen.getByTestId('request-action-enabled').props.children).toBe('true')
    expect(screen.getByTestId('connect-wallet')).toBeTruthy()
    expect(screen.getByTestId('request-rejection')).toBeTruthy()
  })

  it('clears rejected requests and enables retry in fixed mode', async () => {
    wallet.current.signMessages.mockRejectedValueOnce(
      Object.assign(new Error('The wallet declined to sign'), { code: -3 }),
    )
    const screen = await render(<RejectionFixture variant="fixed" />)

    await fireEvent.press(screen.getByTestId('request-rejection'))

    expect(await screen.findByText(/^USER_REJECTED$/)).toBeTruthy()
    expect(screen.getByTestId('request-pending').props.children).toBe('false')
    expect(screen.getByTestId('request-action-enabled').props.children).toBe('true')
    expect(screen.getByTestId('request-rejection').props.accessibilityState).toEqual({ disabled: false })
    expect(wallet.current.signMessages).toHaveBeenCalledOnce()
  })

  it('stays pending and disables retry after rejection in broken mode', async () => {
    wallet.current.signMessages.mockRejectedValueOnce(new Error('User rejected the request'))
    const screen = await render(<RejectionFixture variant="broken" />)

    await fireEvent.press(screen.getByTestId('request-rejection'))

    expect(await screen.findByText('WAITING')).toBeTruthy()
    expect(screen.getByTestId('fixture-variant').props.children).toBe('broken')
    expect(screen.getByTestId('request-pending').props.children).toBe('true')
    expect(screen.getByTestId('request-action-enabled').props.children).toBe('false')
    expect(screen.getByTestId('request-rejection').props.accessibilityState).toEqual({ disabled: true })
    expect(screen.queryByText(/USER_REJECTED:/)).toBeNull()
  })

  it('offers wallet connection while disconnected', async () => {
    wallet.current.account = null
    const screen = await render(<RejectionFixture variant="fixed" />)

    expect(screen.getByTestId('wallet-state').props.children).toBe('DISCONNECTED')
    expect(screen.getByTestId('request-action-enabled').props.children).toBe('false')
    await fireEvent.press(screen.getByTestId('connect-wallet'))

    expect(wallet.current.connect).toHaveBeenCalledOnce()
  })
})
