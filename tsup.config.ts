import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' }
  },
  // Keep runtime deps external so they're not inlined into the bundle.
  external: [
    '@elizaos/core',
    '@elizaos/plugin-trust',
    '@human.tech/waap-cli',
    'zod'
  ],
  // The CJS bundle contains a `typeof import.meta !== 'undefined'` guard in
  // cliRunner.ts (anchor for createRequire). esbuild emits an
  // empty-import-meta warning for this even though the guard is correct.
  // Silence it; the runtime fallback to __filename is verified.
  esbuildOptions(options) {
    options.logOverride = {
      ...(options.logOverride ?? {}),
      'empty-import-meta': 'silent'
    }
  }
})
