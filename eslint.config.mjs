// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // src/generated is Prisma's output — derived code we neither write nor fix.
    // Linting it is slow and every finding is unactionable.
    ignores: ['eslint.config.mjs', 'src/generated/**', 'dist/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],

      // `const { password, ...rest } = user` is the idiomatic way to OMIT a
      // field. The omitted binding is unused on purpose — that is the whole
      // point — so flagging it would push us toward worse code.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test files legitimately do things production code should not.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
    rules: {
      // `expect(service.method).toHaveBeenCalled()` deliberately references a
      // method without binding it. That is how Jest assertions on mocks work,
      // so the rule fires on correct code here.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
