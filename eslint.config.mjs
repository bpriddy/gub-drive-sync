import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Codebase predates the linter; `any` is pervasive at API boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Both rules mostly flag intentional defensive-init / rethrow patterns
      // here — keep them visible as warnings, not blockers.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
);
