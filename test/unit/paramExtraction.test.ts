import { describe, it, expect } from 'vitest'
import {
  sendTxSchema,
  signMessageSchema,
  signTypedDataSchema,
  getBalanceSchema,
  setPolicySchema,
  signupSchema,
  enable2faSchema,
  requestSchema,
  suggestEmailDomain
} from '../../src/actions/paramExtraction'

describe('security hardening (audit fixes)', () => {
  it('H3: requestSchema rejects a method that could be argv-flag-injected', () => {
    expect(requestSchema.safeParse({ method: 'eth_blockNumber' }).success).toBe(
      true
    )
    // Leading dash → would be parsed as a CLI flag by the bare-positional arg.
    expect(requestSchema.safeParse({ method: '--rpc' }).success).toBe(false)
    expect(requestSchema.safeParse({ method: '-h' }).success).toBe(false)
    expect(
      requestSchema.safeParse({ method: 'eth_call; rm -rf' }).success
    ).toBe(false)
  })

  it('M5: a chat-supplied permissionToken is stripped from the signing schemas', () => {
    const sent = sendTxSchema.parse({
      to: '0x000000000000000000000000000000000000dEaD',
      value: '0.1',
      permissionToken: 'attacker-supplied'
    })
    expect(sent).not.toHaveProperty('permissionToken')
    const signed = signMessageSchema.parse({
      message: 'hi',
      permissionToken: 'x'
    })
    expect(signed).not.toHaveProperty('permissionToken')
  })

  it('M6: rpc URL must be http(s) — other schemes rejected', () => {
    const base = {
      to: '0x000000000000000000000000000000000000dEaD',
      value: '0.1'
    }
    expect(
      sendTxSchema.safeParse({ ...base, rpc: 'https://eth.example.com' })
        .success
    ).toBe(true)
    expect(
      sendTxSchema.safeParse({ ...base, rpc: 'http://127.0.0.1:8545' }).success
    ).toBe(true) // local dev node allowed
    expect(
      sendTxSchema.safeParse({ ...base, rpc: 'file:///etc/passwd' }).success
    ).toBe(false)
    expect(
      sendTxSchema.safeParse({ ...base, rpc: 'ws://evil.example.com' }).success
    ).toBe(false)
  })
})

describe('sendTxSchema', () => {
  it('accepts valid EVM input', () => {
    const r = sendTxSchema.safeParse({
      to: '0x000000000000000000000000000000000000dEaD',
      value: '0.01',
      chainId: 1,
      rpc: 'https://eth.llamarpc.com'
    })
    expect(r.success).toBe(true)
  })

  it('rejects missing to for EVM', () => {
    const r = sendTxSchema.safeParse({ value: '0.01', chainId: 1 })
    expect(r.success).toBe(false)
  })

  it('rejects invalid address', () => {
    const r = sendTxSchema.safeParse({
      to: 'not-an-address',
      value: '0.01',
      chainId: 1
    })
    expect(r.success).toBe(false)
  })

  it('accepts optional data, legacy, permissionToken', () => {
    const r = sendTxSchema.safeParse({
      to: '0x000000000000000000000000000000000000dEaD',
      value: '0',
      chainId: 8453,
      data: '0x095ea7b3',
      legacy: true,
      permissionToken: 'abc.def.ghi'
    })
    expect(r.success).toBe(true)
  })

  it('rejects invalid chainId (zero, negative)', () => {
    expect(
      sendTxSchema.safeParse({
        to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
        value: '1',
        chainId: 0
      }).success
    ).toBe(false)
    expect(
      sendTxSchema.safeParse({
        to: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
        value: '1',
        chainId: -1
      }).success
    ).toBe(false)
  })
})

describe('signMessageSchema', () => {
  it('accepts plain text', () => {
    expect(signMessageSchema.safeParse({ message: 'hello' }).success).toBe(true)
  })
  it('accepts hex 0x', () => {
    expect(
      signMessageSchema.safeParse({ message: '0x48656c6c6f' }).success
    ).toBe(true)
  })
  it('rejects empty', () => {
    expect(signMessageSchema.safeParse({ message: '' }).success).toBe(false)
  })
})

describe('signTypedDataSchema', () => {
  it('accepts EIP-712 shape', () => {
    const r = signTypedDataSchema.safeParse({
      data: {
        types: { EIP712Domain: [{ name: 'name', type: 'string' }] },
        domain: { name: 'Test' },
        primaryType: 'Mail',
        message: { contents: 'hi' }
      }
    })
    expect(r.success).toBe(true)
  })
})

describe('getBalanceSchema', () => {
  it('accepts empty (use defaults)', () => {
    expect(getBalanceSchema.safeParse({}).success).toBe(true)
  })
  it('accepts address + chainId', () => {
    expect(
      getBalanceSchema.safeParse({
        address: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead',
        chainId: 1
      }).success
    ).toBe(true)
  })
})

describe('email typo detection', () => {
  describe('suggestEmailDomain()', () => {
    it('returns null for exact-match common providers', () => {
      expect(suggestEmailDomain('gmail.com')).toBeNull()
      expect(suggestEmailDomain('yahoo.com')).toBeNull()
      expect(suggestEmailDomain('outlook.com')).toBeNull()
      expect(suggestEmailDomain('proton.me')).toBeNull()
    })

    it('returns null for legitimate uncommon domains', () => {
      // We don't want to flag every unfamiliar domain as a typo — only those
      // that look like a 1- or 2-edit slip from a popular provider.
      expect(suggestEmailDomain('humantech.io')).toBeNull()
      expect(suggestEmailDomain('mycompany.dev')).toBeNull()
      expect(suggestEmailDomain('university.edu')).toBeNull()
    })

    it('catches the gmail.come typo from the original bug report', () => {
      expect(suggestEmailDomain('gmail.come')).toBe('gmail.com')
    })

    it('catches common gmail typos', () => {
      expect(suggestEmailDomain('gmial.com')).toBe('gmail.com')
      expect(suggestEmailDomain('gmal.com')).toBe('gmail.com')
      expect(suggestEmailDomain('gmaill.com')).toBe('gmail.com')
      expect(suggestEmailDomain('gmail.co')).toBe('gmail.com')
      expect(suggestEmailDomain('gmail.con')).toBe('gmail.com')
    })

    it('catches typos for other popular providers', () => {
      expect(suggestEmailDomain('yahooo.com')).toBe('yahoo.com')
      expect(suggestEmailDomain('outlok.com')).toBe('outlook.com')
      expect(suggestEmailDomain('hotmial.com')).toBe('hotmail.com')
      expect(suggestEmailDomain('iclod.com')).toBe('icloud.com')
    })
  })

  describe('signupSchema email validation', () => {
    it('accepts valid gmail.com', () => {
      const r = signupSchema.safeParse({
        email: 'agent@gmail.com',
        password: 'longenough'
      })
      expect(r.success).toBe(true)
    })

    it('rejects gmail.come (the original bug)', () => {
      const r = signupSchema.safeParse({
        email: 'agent.ponji@gmail.come',
        password: 'longenough'
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join(' | ')
        expect(msg).toContain('gmail.com')
        expect(msg).toContain('typo')
      }
    })

    it('rejects malformed email (basic Zod validation still applies)', () => {
      const r = signupSchema.safeParse({
        email: 'not-an-email',
        password: 'longenough'
      })
      expect(r.success).toBe(false)
    })
  })

  describe('enable2faSchema email validation', () => {
    it('accepts valid email for method=email', () => {
      const r = enable2faSchema.safeParse({
        method: 'email',
        email: 'agent@gmail.com'
      })
      expect(r.success).toBe(true)
    })

    it('rejects typo email for method=email', () => {
      const r = enable2faSchema.safeParse({
        method: 'email',
        email: 'agent@gmial.com'
      })
      expect(r.success).toBe(false)
    })

    it('rejects method=phone — phone 2FA is not enable-able (would brick the session)', () => {
      const r = enable2faSchema.safeParse({
        method: 'phone',
        phoneNumber: '+15551234567'
      })
      expect(r.success).toBe(false)
    })

    it('accepts telegram and external_wallet', () => {
      expect(
        enable2faSchema.safeParse({
          method: 'telegram',
          telegramChatId: '7381029636'
        }).success
      ).toBe(true)
      expect(
        enable2faSchema.safeParse({
          method: 'external_wallet',
          walletAddress: '0x' + 'a'.repeat(40)
        }).success
      ).toBe(true)
    })
  })
})

describe('getBalanceSchema (extended for Sui)', () => {
  it('accepts numeric chainId for EVM', () => {
    expect(getBalanceSchema.safeParse({ chainId: 137 }).success).toBe(true)
  })

  it('accepts canonical sui chain string', () => {
    expect(getBalanceSchema.safeParse({ chainId: 'sui:mainnet' }).success).toBe(
      true
    )
    expect(getBalanceSchema.safeParse({ chainId: 'sui:testnet' }).success).toBe(
      true
    )
  })

  it('accepts bare "sui" shorthand', () => {
    expect(getBalanceSchema.safeParse({ chainId: 'sui' }).success).toBe(true)
  })

  it('rejects empty string chainId', () => {
    expect(getBalanceSchema.safeParse({ chainId: '' }).success).toBe(false)
  })
})

describe('setPolicySchema', () => {
  it('accepts valid spend limit', () => {
    expect(setPolicySchema.safeParse({ dailySpendLimitUsd: 500 }).success).toBe(
      true
    )
  })
  it('rejects over 10000', () => {
    expect(
      setPolicySchema.safeParse({ dailySpendLimitUsd: 10001 }).success
    ).toBe(false)
  })
  it('rejects negative', () => {
    expect(setPolicySchema.safeParse({ dailySpendLimitUsd: -1 }).success).toBe(
      false
    )
  })
})
