import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback
} from '@elizaos/core'

import {
  emitLiveText,
  formatNetworkError,
  getWaapServiceRaw,
  isNetworkError,
  rejectNoService
} from './actionUtils'
import { extractSignupParams } from './paramExtraction'

export const signupAction: Action = {
  name: 'WAAP_SIGNUP',
  similes: ['CREATE_WALLET', 'CREATE_ACCOUNT', 'REGISTER'],
  description:
    'Create a new WaaP wallet account (a 2PC-MPC wallet). Credentials come from the message (email + password ≥8 chars) OR, for an agent-owned wallet, from agent settings (WAAP_EMAIL / WAAP_PASSWORD) when the operator has configured them. Dispatch whenever the user asks to create/register a wallet: if neither the message nor settings carry credentials, the action replies asking for them — so you do not need credentials in the message to dispatch. When you dispatch WAAP_SIGNUP, do NOT also ask the user for their email or password in your reply — the action resolves credentials itself and asks only if none are available.',

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory
  ): Promise<boolean> => {
    const svc = getWaapServiceRaw(runtime)

    return !!svc && !svc.isReady()
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const svc = getWaapServiceRaw(runtime)

    if (!svc) {
      return rejectNoService(callback)
    }

    const params = await extractSignupParams(runtime, message, state)

    if (!params.ok) {
      const text = `Invalid signup details: ${params.error}`
      await callback?.({ text })

      return { success: false, text, error: new Error(text) }
    }

    const emailLabel = params.value.email

    try {
      const result = await svc.signup(
        params.value.email,
        params.value.password,
        params.value.name
      )
      // Array+join keeps each line independently legible to the LLM and
      // avoids the literal `\n` echo issue when the result is relayed
      // through downstream prompts.
      const lines = [
        `🎉 Account created and logged in as ${emailLabel}.`,
        `- EVM address: ${result.address}`
      ]
      if (result.suiAddress) lines.push(`- Sui address: ${result.suiAddress}`)

      // Report the ACTUAL 2FA method the new account was provisioned with —
      // read from the same in-memory policy state the waapWallet provider
      // serves (populated by initialize() at the tail of signup()). Do NOT
      // hardcode "disabled": this backend provisions email-signup accounts
      // with email 2FA by default, and claiming the wallet is unprotected
      // when it isn't (or the reverse) is a security-relevant lie. Mirrors the
      // login action. Wrap in try — if the state shape is unexpected the
      // signup itself still succeeded, so we just omit the 2FA line.
      let policyMethod: string | undefined
      try {
        policyMethod = svc.getState().policy.authorizationMethod
      } catch {
        policyMethod = undefined
      }
      if (policyMethod === 'disabled') {
        lines.push(
          '',
          '⚠️  2FA is DISABLED on this new account — anyone with the password can move funds.',
          '   Say `enable 2FA via email your-email@example.com` (or pick another method: Telegram / external wallet) to require approval before signing.'
        )
      } else if (policyMethod) {
        lines.push(
          `- 2FA method: ${policyMethod} (already protecting this account)`
        )
      }

      const richText = lines.join('\n')
      // Push the multi-line bubble verbatim via the live channel so it isn't
      // stored in conversation memory as a JSON-escaped blob — that's where
      // the LLM picks up `\n` as escape characters and re-emits them as the
      // literal two-character sequence in follow-up summaries. The terse
      // callback text below is what the LLM actually sees in memory.
      const liveOk = await emitLiveText(runtime, message, richText)
      const callbackText = liveOk
        ? `Account created for ${emailLabel}.`
        : richText

      // Only assert twoFa* when we actually read the method — otherwise a
      // hardcoded value would be exactly the false ground truth this fixes.
      const policyContent =
        policyMethod !== undefined
          ? {
              twoFaEnabled: policyMethod !== 'disabled',
              twoFaMethod: policyMethod
            }
          : {}

      await callback?.({
        text: callbackText,
        content: {
          address: result.address,
          suiAddress: result.suiAddress,
          ...policyContent
        }
      })

      return {
        success: true,
        text: callbackText,
        data: {
          address: result.address,
          suiAddress: result.suiAddress,
          ...policyContent
        }
      }
    } catch (err) {
      const error = err as Error

      if (error.message.includes('already exists')) {
        const text = `${emailLabel} already has an account. Would you like to log in instead?`
        await callback?.({ text })

        return { success: false, text, error }
      }

      // Unreachable-backend → use the shared diagnostic so the remediation
      // stays consistent across login/signup/sendTx/etc. The single source
      // of truth lives in actionUtils.formatNetworkError.
      const text = isNetworkError(error.message)
        ? `Signup failed for ${emailLabel}.\n\n${formatNetworkError(
            error.message
          )}`
        : `Signup failed for ${emailLabel}: ${error.message}`
      await callback?.({ text })

      return { success: false, text, error }
    }
  },

  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Create a new wallet with email test@example.com and password mySecurePass123'
        }
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll create a new WaaP wallet account for you now.",
          thought:
            "User wants to create a new WaaP wallet. I'll use WAAP_SIGNUP to register with the provided email and password, creating a 2PC-MPC wallet.",
          actions: ['WAAP_SIGNUP']
        }
      }
    ],
    // Bare-token format: an email + a non-email word, with or without a
    // `signup` verb, counts as both credentials. Don't refuse to dispatch
    // just because the user skipped the "password" keyword.
    [
      {
        name: '{{user}}',
        content: { text: 'alice@example.com MySecure123 signup' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Creating your wallet now.',
          thought:
            "Bare-token credentials with the verb at the end. Email = @-containing token, password = the other non-verb token. WAAP_SIGNUP's extractor handles this format directly.",
          actions: ['WAAP_SIGNUP']
        }
      }
    ],
    [
      {
        name: '{{user}}',
        content: { text: 'signup alice@example.com MySecure123' }
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Creating your wallet now.',
          thought:
            'Verb + email + password (no keywords). Both credentials are present, so dispatch WAAP_SIGNUP.',
          actions: ['WAAP_SIGNUP']
        }
      }
    ],
    [
      { name: '{{user}}', content: { text: 'Sign me up for a wallet' } },
      {
        name: '{{agent}}',
        content: {
          text: 'Setting up your new WaaP wallet now.',
          thought:
            "User wants to create a wallet but didn't include credentials. For an agent-owned wallet the credentials may be configured in settings (WAAP_EMAIL / WAAP_PASSWORD), so I dispatch WAAP_SIGNUP — its extractor uses message credentials if present, otherwise the configured ones, and asks for them if neither is available.",
          actions: ['WAAP_SIGNUP']
        }
      }
    ]
  ]
}
