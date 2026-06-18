# @human.tech/plugin-waap

ElizaOS plugin for the **WaaP wallet** — 2-of-2 MPC signing for EVM and Sui transactions, with native 2FA support, server-enforced spending policies, and zero private-key exposure to the agent process.

> **Status:** Full EVM + Sui support. 20 actions, 543 tests.

## Why this plugin (vs. Coinbase AgentKit)

| Property                                | Coinbase AgentKit      | `@human.tech/plugin-waap`                                                              |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| Wallet model                            | Operator-held API keys | 2-of-2 MPC, no single party holds the key                                              |
| Credential surface in agent process     | API keys in env vars   | None — only a session file path                                                        |
| Approval flow for high-risk txs         | None                   | Native 2FA via Telegram/email/external wallet, surfaced to the user via Eliza callback |
| Spend limit enforcement                 | Application-level      | Server-side policy engine                                                              |
| Plugin can sign without user permission | Yes (holds keys)       | No (2FA required unless explicitly disabled or permission token issued)                |

## Installation

```bash
npm install @human.tech/plugin-waap
# or: pnpm add @human.tech/plugin-waap
```

Then add it to your character's `plugins` array:

```json
{
  "plugins": [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-bootstrap",
    "@human.tech/plugin-waap"
  ]
}
```

The plugin depends on [`@human.tech/waap-cli`](https://www.npmjs.com/package/@human.tech/waap-cli), which is installed automatically as a normal dependency — the plugin shells out to it for all signing operations.

## Getting Started

No provisioning needed. The plugin starts in unauthenticated mode and lets users create or connect wallets through chat:

1. Add `@human.tech/plugin-waap` to your agent's plugins (via character.json or the web UI)
2. Start your agent
3. Chat: "Create a wallet" — the agent will ask for email/password and create a WaaP account
4. Or chat: "Log in with my email" — to connect an existing account

All settings are optional and auto-configured:

- Session storage: `~/.eliza/<agentId>/waap/` (auto-generated per agent)
- Chain: Ethereum mainnet (switchable via "switch to polygon")
- RPC: Auto-resolved from chainid.network

To run an **agent-owned wallet** that logs in automatically (without credentials ever entering chat), set `WAAP_EMAIL` / `WAAP_PASSWORD` in the character's `secrets`.

## Environment variables

| Variable                          | Required | Default                      | Description                                                                                                                                                                                                                                     |
| --------------------------------- | -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WAAP_CLI_SESSION_DIR`            | no       | `~/.eliza/<agentId>/waap`    | Per-agent session directory. Operator runs `waap-cli login` here.                                                                                                                                                                               |
| `WAAP_EMAIL`                      | no       | —                            | Account email for **agent-owned login**. With `WAAP_PASSWORD` set, the user just says "log in" / "create a wallet" and the agent authenticates from these — credentials never enter chat, conversation memory, or any model prompt. **Secret.** |
| `WAAP_PASSWORD`                   | no       | —                            | Account password paired with `WAAP_EMAIL`. **Secret — keep in env / character secrets; never type it in chat.**                                                                                                                                 |
| `WAAP_NAME`                       | no       | email prefix                 | Optional display name, used only by `WAAP_SIGNUP` when creating the account from settings.                                                                                                                                                      |
| `WAAP_DEFAULT_CHAIN`              | no       | `1` (Ethereum mainnet)       | Default chain. Accepts `evm:137`, `sui:mainnet`, `polygon`, `1`, etc. Switchable via WAAP_SWITCH_CHAIN.                                                                                                                                         |
| `WAAP_DEFAULT_CHAIN_ID`           | no       | (deprecated)                 | Fallback for `WAAP_DEFAULT_CHAIN`. Use `WAAP_DEFAULT_CHAIN` instead.                                                                                                                                                                            |
| `WAAP_DEFAULT_RPC_URL`            | no       | (CLI's default)              | RPC URL for the configured chain.                                                                                                                                                                                                               |
| `WAAP_PERMISSION_TOKEN_<chainId>` | no       | —                            | Pre-issued permission token to bypass 2FA for a specific chain. **Bearer credential — treat as a secret. Rotate.**                                                                                                                              |
| `WAAP_CLI_BINARY`                 | no       | resolved from `node_modules` | Override path to the `waap-cli` binary (escape hatch).                                                                                                                                                                                          |
| `SILK_NODE_ENV`                   | no       | `production`                 | WaaP backend target — `development` or `production`.                                                                                                                                                                                            |

## Security model

1. **Password handling in signup/login only.** During `WAAP_SIGNUP` and `WAAP_LOGIN`, the password is passed directly to the CLI subprocess and never stored in ElizaOS memory, database, or response callbacks. After authentication, only the session token is retained. Credentials supplied via `WAAP_EMAIL`/`WAAP_PASSWORD` settings are extracted deterministically and never sent to the LLM.
2. **No private key exposure.** WaaP uses 2-of-2 MPC; the encrypted keyshare lives in the session directory and is never read by the plugin. This is the headline differentiator vs. plugins that hold raw keys.
3. **Per-agent isolation.** `WAAP_CLI_SESSION_DIR` is derived from `runtime.agentId` so two agents on one host get two independent session files.
4. **No `shell: true`.** All CLI invocations spawn via `argv` arrays — zero command-injection surface. Recipient addresses, amounts, and RPC URLs are schema-validated before they reach the subprocess.
5. **2FA-gated financial actions.** Signing, sending, and policy/2FA-admin actions require 2FA approval (unless the wallet has 2FA disabled or a permission token is configured). Operators are strongly encouraged to gate the `financial` / `admin` actions per character via [`@elizaos/plugin-trust`](https://www.npmjs.com/package/@elizaos/plugin-trust) — see the risk tiers in the Actions table.

## Actions (20 total)

| Action                 | Risk tier   | Chains   | What it does                                              |
| ---------------------- | ----------- | -------- | --------------------------------------------------------- |
| `WAAP_SIGNUP`          | auth        | N/A      | Create a new WaaP wallet account with email/password      |
| `WAAP_LOGIN`           | auth        | N/A      | Log in to an existing WaaP account                        |
| `WAAP_LOGOUT`          | auth        | N/A      | Log out and clear session                                 |
| `WAAP_GET_ADDRESS`     | read        | EVM, Sui | Return the wallet's EVM and Sui addresses                 |
| `WAAP_GET_BALANCE`     | read        | EVM, Sui | Read native balance (ETH or SUI) — no 2FA                 |
| `WAAP_GET_CHAIN`       | read        | EVM, Sui | Report the active chain                                   |
| `WAAP_GET_POLICY`      | read        | N/A      | Report the wallet's daily spend limit                     |
| `WAAP_LIST_CHAINS`     | read        | EVM, Sui | List supported chains                                     |
| `WAAP_WALLET_STATUS`   | read        | EVM, Sui | Summarize addresses, chain, 2FA, policy, pending approval |
| `WAAP_2FA_STATUS`      | read        | N/A      | Check current 2FA method                                  |
| `WAAP_SWITCH_CHAIN`    | read        | EVM, Sui | Switch active chain (e.g. "switch to polygon", "use sui") |
| `WAAP_REQUEST`         | read        | EVM only | Generic EIP-1193 JSON-RPC request — rejects on Sui        |
| `WAAP_SIGN_MESSAGE`    | `financial` | EVM, Sui | EIP-191 personal_sign (EVM) / native sign (Sui)           |
| `WAAP_SIGN_TYPED_DATA` | `financial` | EVM only | EIP-712 structured data sign — rejects on Sui             |
| `WAAP_SIGN_TX`         | `financial` | EVM, Sui | Sign transaction without broadcasting                     |
| `WAAP_SEND_TX`         | `financial` | EVM, Sui | Sign + broadcast transaction (ETH for EVM, MIST for Sui)  |
| `WAAP_SET_POLICY`      | `admin`     | N/A      | Update wallet's daily spend limit                         |
| `WAAP_ENABLE_2FA`      | `admin`     | N/A      | Enable 2FA (email, telegram, or external wallet)          |
| `WAAP_DISABLE_2FA`     | `admin`     | N/A      | Disable 2FA (requires current-method approval)            |
| `WAAP_CANCEL_2FA`      | `admin`     | N/A      | Cancel a pending 2FA approval                             |

> **Amount units:** EVM sends/signs take the value in the chain's native units (e.g. ETH); Sui takes **integer MIST** (1 SUI = 1,000,000,000 MIST). The plugin rejects fractional MIST and addresses whose length doesn't match the active chain before signing.

## Provider

`waapWallet` injects both wallet addresses, the active chain, 2FA method, and daily spend limit into the agent's prompt context every turn. ~80 tokens. Cached — does not call the CLI per turn.

The provider outputs text like:

```
Wallet: authenticated
EVM address: 0xabc123...
Sui address: 0x7f8e9d... (64 hex chars)
Active chain: sui:mainnet
```

And exposes structured `values`:

```ts
{
  waapAddress: string,          // active address (EVM or Sui depending on chain)
  waapEvmAddress: string,       // always available
  waapSuiAddress: string,       // always available
  waapChainCanonical: 'evm:137' | 'sui:mainnet',
  waapChainFamily: 'evm' | 'sui',
  waapEvmChainId: number | undefined,
  waapSuiNetwork: 'mainnet' | 'testnet' | 'devnet' | undefined,
  waap2faMethod: 'email' | 'telegram' | 'external_wallet' | 'phone' | 'disabled',
  waapDailyLimitUsd: number | undefined
}
```

## 2FA flow

When a wallet has 2FA enabled and the agent attempts a signing operation, the plugin:

1. Submits the request to the policy engine
2. Receives `awaiting_2fa` event from the CLI
3. Sends a callback message to the user: _"Approve this transaction in Telegram. I'll wait up to 5 minutes."_
4. Waits up to 5 minutes for approval (the CLI handles the WebSocket + HTTP poll fallback internally)
5. On approval, completes the 2PC signature and reports the result

**Phone 2FA is not supported.** The plugin refuses to start if `phone_authz` is the configured method (the CLI's stdin OTP prompt can't be proxied through a non-TTY subprocess). Switch to telegram, email, or external_wallet via `waap-cli 2fa enable --telegram <chatId>`.

## Troubleshooting

| Error code                               | Cause                                           | Fix                                                                                             |
| ---------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `NO_SESSION`                             | No logged-in session exists                     | Chat "create a wallet" or "log in" to authenticate. Or provision manually via `waap-cli login`. |
| `PHONE_2FA_UNSUPPORTED`                  | Wallet has phone 2FA enabled                    | Switch to telegram/email/external_wallet via `waap-cli 2fa enable`                              |
| `POLICY_REJECTED`                        | Daily spend limit exceeded or other policy rule | Use `WAAP_SET_POLICY` to raise the limit (with operator approval)                               |
| `INSUFFICIENT_FUNDS`                     | Wallet doesn't have enough balance + gas        | Top up the wallet                                                                               |
| `TWO_FA_TIMEOUT`                         | User didn't approve within 5 minutes            | Try again                                                                                       |
| `NETWORK`                                | Backend or RPC unreachable                      | Check connectivity, retry                                                                       |
| `CLI_NOT_FOUND` / `CLI_VERSION_MISMATCH` | `waap-cli` binary missing or too old            | Reinstall deps; or set `WAAP_CLI_BINARY` to the binary path                                     |

The `PHONE_2FA_UNSUPPORTED` error throws at agent boot — the agent will refuse to start until it's fixed. `NO_SESSION` no longer throws at boot; the plugin starts in unauthenticated mode and prompts the user to sign up or log in. Other errors are reported via the action's callback to the user.

## Development

```bash
git clone https://github.com/holonym-foundation/eliza-plugin-waap.git
cd eliza-plugin-waap
pnpm install

pnpm test          # 543 unit/integration tests (vitest, mocked runtime — no backend needed)
pnpm type-check    # tsc --noEmit
pnpm build         # tsup → dist/{index.js, index.cjs, index.d.ts, index.d.mts}
```

Unit tests run entirely against a mocked `IAgentRuntime` and a `fake-cli.ts` fixture, so no WaaP backend or credentials are required.

### Testing in a real ElizaOS agent

To exercise the plugin against a live agent using your local build:

```bash
# 1. Build + link the local plugin
pnpm build
npm link

# 2. A throwaway agent project that uses the local build
mkdir -p ~/waap-agent-test && cd ~/waap-agent-test
npm init -y
npm link @human.tech/plugin-waap

# 3. Provision a wallet session (the plugin reads this)
waap-cli signup     # or: waap-cli login

# 4. Create character.json listing "@human.tech/plugin-waap" in plugins
#    (see the example character.json in this repo)

# 5. Run it (configure agent secrets first — see "Agent secrets" below)
elizaos start --character ./character.json
# → open http://localhost:3000 and chat: "what's my address?", "what's my balance?"
```

`npm link` makes the agent load your working copy instead of the published version. After changing code, re-run `pnpm build` and restart the agent.

#### Agent secrets

Configure these in the agent's **secrets** — the character's `secrets` block, the web UI **Secret** tab, or a `.env` file. Don't hardcode them in committed files.

| Secret            | Required | What it's for                                                                                                                                                         |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`  | yes      | The agent's LLM (for `@elizaos/plugin-openai`). This is an **ElizaOS model** requirement, not a WaaP setting — without a valid key the agent boots but can't respond. |
| `WAAP_EMAIL`      | optional | Agent-owned WaaP login. Paired with `WAAP_PASSWORD`, the agent authenticates without credentials ever entering chat. Omit to log in interactively via chat instead.   |
| `WAAP_PASSWORD`   | optional | Password for `WAAP_EMAIL`.                                                                                                                                            |
| `PGLITE_DATA_DIR` | optional | Where ElizaOS stores its embedded PGlite database (agent memory). ElizaOS setting, not WaaP. Default: `./.eliza/.elizadb`.                                            |
| `SERVER_PORT`     | optional | Port the ElizaOS agent server listens on. ElizaOS setting, not WaaP. Default: `3000`.                                                                                 |

> If you set `OPENAI_API_KEY` in the UI/character **and** have it exported in your shell, the **shell env wins** — run `unset OPENAI_API_KEY` so a stale/placeholder value can't override the real one.

## Architecture notes

- Consumes `@human.tech/waap-cli` (a published npm dependency) and shells out to it for every signing operation.
- LLM-driven param extractors use the canonical Eliza 1.x pattern (`composePromptFromState` + `runtime.useModel(ModelType.TEXT_SMALL)` + `parseJSONObjectFromText` + zod validation), with a deterministic regex extractor for credentials (so passwords never reach the model) and for `WAAP_SIGN_TYPED_DATA` (EIP-712 JSON blobs are too complex for reliable LLM round-trip).
- Dual-address model: a single keyshare derives both an EVM and a Sui address. Both are stored in state and shown in provider context. `getAddress()` returns the one matching the active chain.
- In-memory chain state with an explicit `--chain` flag on every CLI call — avoids side effects on the CLI session file.

## License

MIT — see [LICENSE](./LICENSE).
