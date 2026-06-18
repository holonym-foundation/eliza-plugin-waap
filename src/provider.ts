import type {
  Provider,
  IAgentRuntime,
  Memory,
  State,
  ProviderResult
} from '@elizaos/core'

import { supportedChainsText } from './chains'
import { WaapService } from './services/WaapService'

export const waapWalletProvider: Provider = {
  name: 'waapWallet',
  description: 'Current WaaP wallet address, chain, policy, and 2FA status',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const svc = runtime.getService<WaapService>(WaapService.serviceType)

    // Three startup states must be ground separately, otherwise the LLM
    // misreports during the 1–3 sec post-restart whoami window:
    //   1. Service not yet registered → "service not available"
    //   2. Service registered, mid-hydration (initializing=true) → "starting up"
    //   3. Initialized, no saved session (ready=false, initializing=false) → "not logged in"
    //   4. Ready (state populated) → log out the wallet snapshot
    if (svc?.isInitializing?.()) {
      // Don't claim "logged in" or "not logged in" while whoami is in flight —
      // either claim becomes a lie within seconds. Tell the LLM to wait
      // instead of replying about login state.
      const text = [
        '# WaaP Wallet',
        '',
        'The WaaP wallet is **starting up** — the saved session is still being loaded.',
        'Do NOT answer wallet-status questions yet (login state, addresses, balances). Reply briefly that the wallet is initializing and ask the user to retry in a moment.',
        ''
      ].join('\n')

      return {
        text,
        values: { waapLoggedIn: false, waapInitializing: true },
        data: {}
      }
    }

    if (!svc?.isReady()) {
      // Ground the logged-out state explicitly. Returning empty text leaves
      // the LLM with no factual context for status questions ("am I logged
      // in?") and it confabulates a confident "yes" — which then contradicts
      // the action layer the moment the user asks for anything that needs an
      // authenticated session.
      const text = [
        '# WaaP Wallet',
        '',
        'The WaaP wallet is **not logged in**.',
        'The user must sign up (WAAP_SIGNUP) or log in (WAAP_LOGIN) before any wallet feature — addresses, balances, signing, sending — can be used.',
        'Do NOT claim the user is logged in, has an address, or has any wallet state until a successful login or signup.',
        ''
      ].join('\n')

      return {
        text,
        values: { waapLoggedIn: false, waapInitializing: false },
        data: {}
      }
    }

    const s = svc.getState()
    const limit =
      s.policy.dailySpendLimitUsd != null
        ? `$${s.policy.dailySpendLimitUsd}/day`
        : 'no limit set'

    const activeAddress =
      s.chainState.family === 'sui' ? s.suiAddress : s.evmAddress

    const pending = svc.getPendingAuthz()
    const pendingLine = pending
      ? `- Pending 2FA: a ${pending.kind} request is awaiting ${
          pending.method ?? 'approval'
        } (started ${new Date(
          pending.startedAt
        ).toISOString()}). The user must approve via their 2FA channel or cancel it before starting another authz-gated op.`
      : '- Pending 2FA: none'

    // Use Markdown structure with explicit real newlines. Every wallet fact
    // the LLM might be asked about lives here verbatim — login status,
    // addresses, chain, 2FA method, spend limit, pending authz, supported
    // chains. The grounding contract in the character system prompt forbids
    // the LLM from inventing any wallet fact not listed below.
    const text = [
      '# WaaP Wallet',
      '',
      'The WaaP wallet is **logged in**.',
      'This is a dual-chain wallet — the user has TWO wallet addresses.',
      'When the user asks for their address, ALWAYS show both addresses, each on its own line, using real Markdown line breaks (NOT the literal characters backslash-n).',
      '',
      `- EVM address: \`${s.evmAddress}\``,
      `- Sui address: \`${s.suiAddress}\``,
      `- Active chain: ${s.chainState.canonical}`,
      `- 2FA method: ${s.policy.authorizationMethod}`,
      `- Daily spend limit: ${limit}`,
      pendingLine,
      `- Supported chains: ${supportedChainsText()}`,
      ''
    ].join('\n')

    return {
      text,
      values: {
        waapLoggedIn: true,
        waapEvmAddress: s.evmAddress,
        waapSuiAddress: s.suiAddress,
        waapAddress: activeAddress,
        waapChainCanonical: s.chainState.canonical,
        waapChainFamily: s.chainState.family,
        waapEvmChainId:
          s.chainState.family === 'evm' ? s.chainState.chainId : undefined,
        waapSuiNetwork:
          s.chainState.family === 'sui' ? s.chainState.network : undefined,
        waap2faMethod: s.policy.authorizationMethod,
        waapDailyLimitUsd: s.policy.dailySpendLimitUsd,
        waapPendingAuthzKind: pending?.kind,
        waapPendingAuthzMethod: pending?.method
      },
      data: { policy: s.policy, pendingAuthz: pending }
    }
  }
}
