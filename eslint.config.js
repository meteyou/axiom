import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.nuxt/**', '**/.output/**'],
  },
  {
    rules: {
      // Allow intentionally unused variables/parameters prefixed with `_`.
      // This convention is used throughout the codebase (e.g. `for (const _ of iter)`
      // to consume an async iterator without naming the yielded value).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
)
