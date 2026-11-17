const [{ default: tseslint }, { default: tsParser }] = await Promise.all([
  import('@typescript-eslint/eslint-plugin'),
  import('@typescript-eslint/parser'),
]);

export default [
  {
    ignores: [
      '.astro/**',
      'dist/**',
      'drizzle/**',
      'node_modules/**',
      'public/**',
      'worker-configuration.d.ts',
      '**/*.test.ts',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
];
