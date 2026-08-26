import { fireEvent, render } from '@testing-library/react-native'
import type { Address } from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAuthorizationFailedError,
  StaleAuthorizationFixture,
} from '@/features/stale-authorization/stale-authorization-fixture'

const TEST_ADDRESS = 'GsbwXfJraMomNxBcjK9jJ3YuPBQTd7pTvbwEfJvvZoP1' as Address
const TEST_AUTH_TOKEN = 'test-only-auth-token-that-must-not-render'

const fixture = vi.hoisted(() => {
  const remoteWallet = {
    authorize: vi.fn(),
    deauthorize: vi.fn(),
  }
  const wallet = {
    current: {
      account: { address: 'GsbwXfJraMomNxBcjK9jJ3YuPBQTd7pTvbwEfJvvZoP1', label: 'Test Wallet' } as
        | { address: string; label: string }
        | undefined,
      chain: 'solana:devnet',
      connect: vi.fn(),
      identity: { name: 'LaunchRig Fixture' },
      store: {
        $authToken: { get: vi.fn() },
        persist: vi.fn(),
      },
    },
  }
  const transact = vi.fn()

  return { remoteWallet, transact, wallet }
})

vi.mock('@wallet-ui/react-native-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wallet-ui/react-native-kit')>()),
  transact: fixture.transact,
  useMobileWallet: () => fixture.wallet.current,
}))

function value(screen: Awaited<ReturnType<typeof render>>, testID: string) {
  return screen.getByTestId(testID).props.children
}

describe('StaleAuthorizationFixture', () => {
  beforeEach(() => {
    fixture.remoteWallet.authorize.mockReset()
    fixture.remoteWallet.deauthorize.mockReset().mockResolvedValue(undefined)
    fixture.transact.mockReset().mockImplementation(async (callback) => callback(fixture.remoteWallet))
    fixture.wallet.current.account = { address: TEST_ADDRESS, label: 'Test Wallet' }
    fixture.wallet.current.connect.mockReset().mockImplementation(async () => {
      fixture.wallet.current.account = { address: TEST_ADDRESS, label: 'Test Wallet' }
      return fixture.wallet.current.account
    })
    fixture.wallet.current.store.$authToken.get.mockReset().mockReturnValue(TEST_AUTH_TOKEN)
    fixture.wallet.current.store.persist.mockReset().mockImplementation(async (authorization) => {
      if (authorization === null) {
        fixture.wallet.current.account = undefined
      }
    })
  })

  it('exposes the stable stale-authorization contract without rendering the auth token', async () => {
    const screen = await render(<StaleAuthorizationFixture variant="fixed" />)

    expect(value(screen, 'fixture-ready')).toBe('READY')
    expect(value(screen, 'fixture-scenario')).toBe('stale-authorization')
    expect(value(screen, 'fixture-variant')).toBe('fixed')
    expect(value(screen, 'wallet-state')).toBe('CONNECTED')
    expect(value(screen, 'stale-auth-seeded')).toBe('false')
    expect(value(screen, 'reauthorization-pending')).toBe('false')
    expect(value(screen, 'stale-auth-recovered')).toBe('IDLE')
    expect(value(screen, 'seed-action-enabled')).toBe('true')
    expect(value(screen, 'reauthorization-action-enabled')).toBe('false')
    expect(value(screen, 'reconnect-enabled')).toBe('false')
    expect(JSON.stringify(screen.toJSON())).not.toContain(TEST_AUTH_TOKEN)
  })

  it('revokes the real cached authorization without clearing the dapp store', async () => {
    const screen = await render(<StaleAuthorizationFixture variant="fixed" />)

    await fireEvent.press(screen.getByTestId('seed-stale-authorization'))

    expect(fixture.transact).toHaveBeenCalledOnce()
    expect(fixture.remoteWallet.deauthorize).toHaveBeenCalledWith({ auth_token: TEST_AUTH_TOKEN })
    expect(fixture.wallet.current.store.persist).not.toHaveBeenCalled()
    expect(value(screen, 'wallet-state')).toBe('CONNECTED')
    expect(value(screen, 'stale-auth-seeded')).toBe('true')
    expect(value(screen, 'stale-auth-recovered')).toBe('STALE_TOKEN')
    expect(value(screen, 'seed-action-enabled')).toBe('false')
    expect(value(screen, 'reauthorization-action-enabled')).toBe('true')
    expect(JSON.stringify(screen.toJSON())).not.toContain(TEST_AUTH_TOKEN)
  })

  it('clears a stale authorization and enables a manual reconnect in fixed mode', async () => {
    fixture.remoteWallet.authorize.mockRejectedValueOnce(
      Object.assign(new Error('Cached authorization is no longer valid'), { code: -1 }),
    )
    const screen = await render(<StaleAuthorizationFixture variant="fixed" />)

    await fireEvent.press(screen.getByTestId('seed-stale-authorization'))
    await fireEvent.press(screen.getByTestId('request-reauthorization'))

    expect(fixture.remoteWallet.authorize).toHaveBeenCalledWith({
      auth_token: TEST_AUTH_TOKEN,
      chain: 'solana:devnet',
      identity: { name: 'LaunchRig Fixture' },
    })
    expect(fixture.wallet.current.store.persist).toHaveBeenCalledWith(null)
    expect(value(screen, 'reauthorization-pending')).toBe('false')
    expect(value(screen, 'stale-auth-recovered')).toBe('AUTHORIZATION_CLEARED')
    expect(value(screen, 'wallet-state')).toBe('DISCONNECTED')
    expect(value(screen, 'reconnect-enabled')).toBe('true')
    expect(screen.getByTestId('connect-wallet').props.accessibilityState).toEqual({ disabled: false })

    await fireEvent.press(screen.getByTestId('connect-wallet'))

    expect(fixture.wallet.current.connect).toHaveBeenCalledOnce()
    expect(value(screen, 'wallet-state')).toBe('CONNECTED')
    expect(value(screen, 'stale-auth-seeded')).toBe('false')
    expect(value(screen, 'stale-auth-recovered')).toBe('RECONNECTED')
    expect(value(screen, 'seed-action-enabled')).toBe('true')
    expect(value(screen, 'reconnect-enabled')).toBe('false')
    expect(JSON.stringify(screen.toJSON())).not.toContain(TEST_AUTH_TOKEN)
  })

  it('keeps the stale request pending and cached in broken mode', async () => {
    fixture.remoteWallet.authorize.mockRejectedValueOnce(
      Object.assign(new Error('ERROR_AUTHORIZATION_FAILED'), { code: -1 }),
    )
    const screen = await render(<StaleAuthorizationFixture variant="broken" />)

    await fireEvent.press(screen.getByTestId('seed-stale-authorization'))
    await fireEvent.press(screen.getByTestId('request-reauthorization'))

    expect(value(screen, 'reauthorization-pending')).toBe('true')
    expect(value(screen, 'stale-auth-recovered')).toBe('WAITING')
    expect(value(screen, 'wallet-state')).toBe('CONNECTED')
    expect(value(screen, 'reauthorization-action-enabled')).toBe('false')
    expect(value(screen, 'reconnect-enabled')).toBe('false')
    expect(fixture.wallet.current.store.persist).not.toHaveBeenCalled()
    expect(JSON.stringify(screen.toJSON())).not.toContain(TEST_AUTH_TOKEN)
  })

  it('reports unrelated protocol failures without clearing authorization', async () => {
    fixture.remoteWallet.authorize.mockRejectedValueOnce(Object.assign(new Error('Transport unavailable'), { code: -99 }))
    const screen = await render(<StaleAuthorizationFixture variant="fixed" />)

    await fireEvent.press(screen.getByTestId('seed-stale-authorization'))
    await fireEvent.press(screen.getByTestId('request-reauthorization'))

    expect(value(screen, 'reauthorization-pending')).toBe('false')
    expect(value(screen, 'stale-auth-recovered')).toBe('REQUEST_FAILED')
    expect(value(screen, 'wallet-state')).toBe('CONNECTED')
    expect(value(screen, 'reauthorization-action-enabled')).toBe('true')
    expect(fixture.wallet.current.store.persist).not.toHaveBeenCalled()
    expect(screen.getByText('Wallet reauthorization failed.')).toBeTruthy()
  })

  it('does not start a wallet session when no cached token exists', async () => {
    fixture.wallet.current.store.$authToken.get.mockReturnValue(undefined)
    const screen = await render(<StaleAuthorizationFixture variant="fixed" />)

    await fireEvent.press(screen.getByTestId('seed-stale-authorization'))

    expect(fixture.transact).not.toHaveBeenCalled()
    expect(value(screen, 'stale-auth-recovered')).toBe('REQUEST_FAILED')
    expect(screen.getByText('No cached wallet authorization is available.')).toBeTruthy()
  })
})

describe('isAuthorizationFailedError', () => {
  it('recognizes the protocol code and symbolic error without broad false positives', () => {
    expect(isAuthorizationFailedError(Object.assign(new Error('stale'), { code: -1 }))).toBe(true)
    expect(isAuthorizationFailedError({ errorCode: 'ERROR_AUTHORIZATION_FAILED' })).toBe(true)
    expect(isAuthorizationFailedError(new Error('ERROR_AUTHORIZATION_FAILED'))).toBe(true)
    expect(isAuthorizationFailedError(Object.assign(new Error('User rejected'), { code: -3 }))).toBe(false)
    expect(isAuthorizationFailedError(new Error('Authorization request failed for another reason'))).toBe(false)
  })
})
