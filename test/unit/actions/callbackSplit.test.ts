// Verifies the callback-split contract for actions whose final result is
// multi-line:
//
//   - When `runtime.sendMessageToTarget` succeeds, the rich (multi-line) text
//     streams via the live channel and the callback gets a terse single-line
//     text. Goal: keep `\n` out of conversation memory so the LLM can't echo
//     it as the literal two-character escape sequence in follow-up summaries.
//
//   - When `runtime.sendMessageToTarget` is unavailable (no source on the
//     message, no handler registered, etc.), emitLiveText returns false and
//     the rich text falls back into the callback so the user doesn't lose
//     detail on hosts without live streaming.
//
// Covers: signup, login, getBalance, sendTx, signTx, request, twoFaStatus,
// signMessage, signTypedData.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/actions/paramExtraction', async () => {
  const actual = await vi.importActual<any>(
    '../../../src/actions/paramExtraction'
  )
  return {
    ...actual,
    extractSignupParams: vi.fn(),
    extractLoginParams: vi.fn(),
    extractGetBalanceParams: vi.fn(),
    extractSendTxParams: vi.fn(),
    extractSignTxParams: vi.fn(),
    extractRequestParams: vi.fn(),
    extractSignMessageParams: vi.fn(),
    extractSignTypedDataParams: vi.fn()
  }
})

import { signupAction } from '../../../src/actions/signup'
import { loginAction } from '../../../src/actions/login'
import { getBalanceAction } from '../../../src/actions/getBalance'
import { sendTxAction } from '../../../src/actions/sendTx'
import { signTxAction } from '../../../src/actions/signTx'
import { requestAction } from '../../../src/actions/request'
import { twoFaStatusAction } from '../../../src/actions/twoFaStatus'
import { signMessageAction } from '../../../src/actions/signMessage'
import { signTypedDataAction } from '../../../src/actions/signTypedData'
import {
  extractSignupParams,
  extractLoginParams,
  extractGetBalanceParams,
  extractSendTxParams,
  extractSignTxParams,
  extractRequestParams,
  extractSignMessageParams,
  extractSignTypedDataParams
} from '../../../src/actions/paramExtraction'

// A message WITH `source` so emitLiveText has somewhere to send to.
const messageWithSource = () =>
  ({
    content: { text: 'do it', source: 'discord' },
    roomId: 'r',
    agentId: 'a'
  }) as any

// A message WITHOUT `source` so emitLiveText logs warn-once and returns false.
const messageWithoutSource = () =>
  ({ content: { text: 'do it' }, roomId: 'r', agentId: 'a' }) as any

const expectNoEscapedNewline = (text: unknown) => {
  // The whole point: when the live channel works, the callback text must
  // not contain the two-character `\n` escape (which the LLM would echo
  // literally). A real newline character is fine — we forbid the escape.
  expect(String(text)).not.toContain('\\n')
}

describe('callback-split contract', () => {
  beforeEach(() => vi.clearAllMocks())

  describe('signup', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => false,
          signup: vi.fn().mockResolvedValue({
            address: '0xevm',
            suiAddress: '0xsui'
          })
        })
      }) as any

    it('live channel ok: callback gets terse single-line text; rich text goes via sendMessageToTarget', async () => {
      ;(extractSignupParams as any).mockResolvedValue({
        ok: true,
        value: { email: 'a@b.com', password: 'pw12345678' }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await signupAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).toContain('a@b.com')
      expect(cbText).not.toContain('\n')
      expectNoEscapedNewline(cbText)

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('0xevm')
      expect(liveText).toContain('0xsui')
      expect(liveText).toContain('\n')
    })

    it('live channel unavailable (no source): callback receives the rich multi-line text as fallback', async () => {
      ;(extractSignupParams as any).mockResolvedValue({
        ok: true,
        value: { email: 'a@b.com', password: 'pw12345678' }
      })
      const callback = vi.fn()
      // No sendMessageToTarget on runtime AND no source on message → emitLiveText
      // returns false and the action inlines the rich text into callback so the
      // user still sees the addresses.
      await signupAction.handler(
        runtime(undefined),
        messageWithoutSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).toContain('0xevm')
      expect(cbText).toContain('0xsui')
      expect(cbText).toContain('\n')
    })
  })

  describe('login', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => false,
          login: vi.fn().mockResolvedValue({
            address: '0xevm',
            suiAddress: '0xsui'
          }),
          getState: () => ({ policy: { authorizationMethod: 'disabled' } })
        })
      }) as any

    it('live channel ok: callback gets terse single-line text; rich text via sendMessageToTarget', async () => {
      ;(extractLoginParams as any).mockResolvedValue({
        ok: true,
        value: { email: 'a@b.com', password: 'pw' }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await loginAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')
      expect(cbText).toContain('a@b.com')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('0xevm')
      expect(liveText).toContain('0xsui')
    })

    it('live channel unavailable: callback receives rich multi-line fallback', async () => {
      ;(extractLoginParams as any).mockResolvedValue({
        ok: true,
        value: { email: 'a@b.com', password: 'pw' }
      })
      const callback = vi.fn()
      await loginAction.handler(
        runtime(undefined),
        messageWithoutSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).toContain('0xevm')
      expect(cbText).toContain('0xsui')
      expect(cbText).toContain('\n')
    })
  })

  describe('getBalance (multi-chain path)', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          getState: () => ({
            chainState: { family: 'evm', chainId: 1 },
            suiAddress: '0xsui'
          }),
          getChainFamily: () => 'evm',
          getBalance: vi
            .fn()
            .mockImplementation(async ({ chainId }: { chainId: any }) => ({
              balanceFormatted: chainId === 'sui:mainnet' ? '5.0' : '1.0',
              balanceRaw: '0',
              chainId,
              address: chainId === 'sui:mainnet' ? '0xsui' : '0xevm'
            }))
        })
      }) as any

    it('live channel ok: callback gets terse line; rich breakdown via sendMessageToTarget', async () => {
      ;(extractGetBalanceParams as any).mockResolvedValue({
        ok: true,
        value: {} // no specific chain → multi-chain breakdown
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await getBalanceAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('EVM')
      expect(liveText).toContain('Sui')
    })
  })

  describe('sendTx (success path)', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          getChainState: () => ({
            family: 'evm',
            chainId: 1,
            canonical: 'evm:1'
          }),
          getChainFamily: () => 'evm',
          sendTx: vi.fn().mockResolvedValue({ txHash: '0xtx', from: '0xevm' })
        })
      }) as any

    it('live channel ok: callback text contains txHash but no `\\n`', async () => {
      ;(extractSendTxParams as any).mockResolvedValue({
        ok: true,
        value: {
          to: '0x000000000000000000000000000000000000dEaD',
          value: '0.01',
          chainId: 1
        }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await sendTxAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).toContain('0xtx')
      expect(cbText).not.toContain('\n')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('0xtx')
      expect(liveText).toContain('\n')
    })
  })

  describe('signTx (success path)', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          getChainState: () => ({
            family: 'evm',
            chainId: 1,
            canonical: 'evm:1'
          }),
          getChainFamily: () => 'evm',
          signTx: vi.fn().mockResolvedValue({
            signedTx: '0x' + 'aa'.repeat(40),
            address: '0xevm'
          })
        })
      }) as any

    it('live channel ok: callback text is single-line', async () => {
      ;(extractSignTxParams as any).mockResolvedValue({
        ok: true,
        value: {
          to: '0x000000000000000000000000000000000000dEaD',
          value: '0.01',
          chainId: 1
        }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await signTxAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')
    })
  })

  describe('request (RPC pretty-print)', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          getChainFamily: () => 'evm',
          request: vi
            .fn()
            .mockResolvedValue({ data: { foo: 'bar', nested: { n: 1 } } })
        })
      }) as any

    it('live channel ok: callback text has no JSON newlines (the highest-leak case)', async () => {
      ;(extractRequestParams as any).mockResolvedValue({
        ok: true,
        value: { method: 'eth_blockNumber', params: [] }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await requestAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      // pretty-printed JSON is exactly the multi-line content we want isolated
      // to the live channel, not stored in conversation memory.
      expect(liveText).toContain('foo')
      expect(liveText).toContain('\n')
    })
  })

  describe('twoFaStatus (disabled-warning)', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          get2faStatus: vi.fn().mockResolvedValue({ method: 'disabled' })
        })
      }) as any

    it('live channel ok: callback text is the terse warning, rich version via sendMessageToTarget', async () => {
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await twoFaStatusAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')
      expect(cbText).toContain('DISABLED')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('Anyone with your password')
      expect(liveText).toContain('\n')
    })
  })

  describe('signMessage', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          signMessage: vi.fn().mockResolvedValue({ signature: '0xsig' })
        })
      }) as any

    it('live channel ok: callback text has no `\\n`; signature appears in live text', async () => {
      ;(extractSignMessageParams as any).mockResolvedValue({
        ok: true,
        value: { message: 'hello' }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await signMessageAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('0xsig')
    })
  })

  describe('signTypedData', () => {
    const runtime = (sendMessageToTarget?: any) =>
      ({
        agentId: 'test-agent',
        sendMessageToTarget,
        getService: () => ({
          isReady: () => true,
          getChainFamily: () => 'evm',
          signTypedData: vi.fn().mockResolvedValue({ signature: '0xsig712' })
        })
      }) as any

    it('live channel ok: callback text has no `\\n`; signature appears in live text', async () => {
      ;(extractSignTypedDataParams as any).mockResolvedValue({
        ok: true,
        value: {
          data: {
            types: { EIP712Domain: [] },
            domain: {},
            primaryType: 'X',
            message: {}
          }
        }
      })
      const callback = vi.fn()
      const sendMessageToTarget = vi.fn().mockResolvedValue(undefined)
      await signTypedDataAction.handler(
        runtime(sendMessageToTarget),
        messageWithSource(),
        undefined,
        {},
        callback
      )
      const cbText = callback.mock.calls[0][0].text
      expect(cbText).not.toContain('\n')

      const liveText = sendMessageToTarget.mock.calls[0][1].text
      expect(liveText).toContain('0xsig712')
    })
  })
})
