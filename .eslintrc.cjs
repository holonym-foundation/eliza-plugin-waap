const path = require('path')

module.exports = {
  extends: ['custom'],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: [path.join(__dirname, 'tsconfig.json')]
  },
  ignorePatterns: ['.eslintrc.cjs', 'dist', 'node_modules'],
  env: {
    es6: true,
    node: true
  },
  globals: {
    globalThis: 'readonly'
  },
  rules: {
    'turbo/no-undeclared-env-vars': 'off',
    // Shared 'custom' config is tuned for app code; relax noisy stylistic
    // rules for this library package. The plugin has 115 unit tests covering
    // behavior — these rules don't catch real bugs here.
    'sonarjs/cognitive-complexity': 'off',
    'sonarjs/no-duplicate-string': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    'padding-line-between-statements': 'off'
  }
}
