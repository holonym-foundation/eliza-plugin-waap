import type { Plugin } from '@elizaos/core'

import { cancel2faAction } from './actions/cancel2fa'
import { disable2faAction } from './actions/disable2fa'
import { enable2faAction } from './actions/enable2fa'
import { getAddressAction } from './actions/getAddress'
import { getBalanceAction } from './actions/getBalance'
import { getChainAction } from './actions/getChain'
import { getPolicyAction } from './actions/getPolicy'
import { listChainsAction } from './actions/listChains'
import { loginAction } from './actions/login'
import { logoutAction } from './actions/logout'
import { requestAction } from './actions/request'
import { sendTxAction } from './actions/sendTx'
import { setPolicyAction } from './actions/setPolicy'
import { signMessageAction } from './actions/signMessage'
import { signTxAction } from './actions/signTx'
import { signTypedDataAction } from './actions/signTypedData'
import { signupAction } from './actions/signup'
import { switchChainAction } from './actions/switchChain'
import { twoFaStatusAction } from './actions/twoFaStatus'
import { walletStatusAction } from './actions/walletStatus'
import { waapWalletProvider } from './provider'
import { WaapService } from './services/WaapService'

// Public exports
export * from './types'
export { WaapService }
export { WaapError, type WaapErrorCode } from './errors'
export { createCliRunner, CliError } from './cliRunner'
export type { CliEvent, CliRunner } from './cliRunner'
export { waapWalletProvider }

export const waapPlugin: Plugin = {
  name: '@human.tech/plugin-waap',
  description:
    'WaaP wallet (2PC-MPC) plugin for ElizaOS — EVM & Sui signing with server-side policy enforcement and 2FA.',

  // ⚠️ KNOWN GAP — `componentDefaults` is structurally correct (matches the
  // reference plugin-agentkit shape) but is **not actively consumed at runtime**
  // by @elizaos/core@1.7.2 or @elizaos/plugin-trust@1.2.1 — neither package
  // references the symbol in its dist code (verified by grep). This block is
  // forward-looking schema for when ElizaOS wires it up.
  //
  // Until ElizaOS honors `componentDefaults`, the `enabled: false` flags below
  // do NOT actually disable any action at runtime. Operators who want a
  // restricted-permission character must remove the corresponding entries from
  // the character's `plugins` array, or fork this plugin with a slimmer
  // `actions` registration list. The bundled `character.json` here is a
  // demo/development character with everything live; do NOT ship it as-is for
  // a production / unsupervised deployment.
  //
  // The `as any` cast is required because @elizaos/core@1.7.2 types
  // Plugin.config as Record<string, primitive>, which can't represent the
  // nested shape.
  config: {
    defaultEnabled: true,
    category: 'blockchain',
    componentDefaults: {
      actions: {
        WAAP_SEND_TX: {
          enabled: false,
          category: 'wallet',
          permissions: ['financial']
        },
        WAAP_SIGN_MESSAGE: {
          enabled: false,
          category: 'wallet',
          permissions: ['financial']
        },
        WAAP_SIGN_TYPED_DATA: {
          enabled: false,
          category: 'wallet',
          permissions: ['financial']
        },
        WAAP_GET_BALANCE: {
          enabled: true,
          category: 'wallet',
          permissions: []
        },
        WAAP_SET_POLICY: {
          enabled: false,
          category: 'wallet',
          permissions: ['admin']
        },
        WAAP_SIGNUP: { enabled: true, category: 'wallet', permissions: [] },
        WAAP_LOGIN: { enabled: true, category: 'wallet', permissions: [] },
        WAAP_SWITCH_CHAIN: {
          enabled: true,
          category: 'wallet',
          permissions: []
        },
        WAAP_2FA_STATUS: { enabled: true, category: 'wallet', permissions: [] },
        WAAP_ENABLE_2FA: {
          enabled: false,
          category: 'wallet',
          permissions: ['admin']
        },
        WAAP_DISABLE_2FA: {
          enabled: false,
          category: 'wallet',
          permissions: ['admin']
        },
        WAAP_LOGOUT: { enabled: true, category: 'wallet', permissions: [] },
        WAAP_SIGN_TX: {
          enabled: false,
          category: 'wallet',
          permissions: ['financial']
        },
        WAAP_REQUEST: { enabled: true, category: 'wallet', permissions: [] },
        WAAP_CANCEL_2FA: { enabled: true, category: 'wallet', permissions: [] }
      },
      providers: {
        waapWallet: { enabled: true, category: 'wallet', permissions: [] }
      }
    }
  } as any,

  services: [WaapService],
  providers: [waapWalletProvider],
  actions: [
    sendTxAction,
    signMessageAction,
    signTypedDataAction,
    getAddressAction,
    getBalanceAction,
    getChainAction,
    getPolicyAction,
    walletStatusAction,
    listChainsAction,
    setPolicyAction,
    signupAction,
    loginAction,
    switchChainAction,
    twoFaStatusAction,
    enable2faAction,
    disable2faAction,
    logoutAction,
    signTxAction,
    requestAction,
    cancel2faAction
  ]
}

export default waapPlugin
