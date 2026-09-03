// Config for `npm run lint:honesty` — see docs/design/waypoint-revamp-architecture.md
// §7.3. Deliberately separate from the main `.eslintrc.js`: the main `lint`
// script runs with `continue-on-error: true` in CI (100+ pre-existing
// violations, see .github/workflows/test.yml), so a rule added there would
// never actually block anything. This config is loaded standalone, with
// `--no-eslintrc`, so it does not inherit — or get diluted by — the main
// config or its violations.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  // Registered (but not enabled — nothing from either plugin is turned on
  // below) purely so ESLint recognizes rule IDs named in this codebase's
  // existing `// eslint-disable-next-line @typescript-eslint/...` and
  // `// eslint-disable-next-line react-hooks/...` comments. Without this,
  // --no-eslintrc means those plugins are never loaded, and ESLint reports
  // every such comment as "Definition for rule '...' was not found" — noise
  // from the main lint job's rules leaking into this unrelated, required gate.
  plugins: ['@typescript-eslint', 'react-hooks'],
  rules: {
    'no-inert-control': 'error',
    'no-actionless-button': 'error',
  },
};
