import eslintPluginAstro from 'eslint-plugin-astro';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

const tsRecommendedRules = Object.assign(
  {},
  ...tseslint.configs['flat/recommended']
    .filter((config) => config.name !== 'typescript-eslint/base')
    .map((config) => config.rules ?? {}),
);

const constVariableNaming = {
  selector: 'variable',
  modifiers: ['const'],
  format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
  leadingUnderscore: 'allow',
};

const variableNaming = {
  selector: 'variable',
  format: ['camelCase', 'UPPER_CASE'],
  leadingUnderscore: 'allow',
};

const sharedNamingRules = [
  { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
  { selector: 'function', format: ['camelCase'] },
  { selector: 'typeLike', format: ['PascalCase'] },
];

const namingConvention = ['error', constVariableNaming, variableNaming, ...sharedNamingRules];

// Astro 允许用 let 保存动态选中的 PascalCase 组件。
const astroNamingConvention = [
  'error',
  constVariableNaming,
  { ...variableNaming, format: ['camelCase', 'PascalCase', 'UPPER_CASE'] },
  ...sharedNamingRules,
];

const projectRules = {
  // D1 batch 语句和插件/主题动态配置在边界处依赖 any，整体收紧的成本过高。
  '@typescript-eslint/no-explicit-any': 'off',
  '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
  '@typescript-eslint/naming-convention': namingConvention,
  'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
  'prefer-const': 'error',
  'no-async-promise-executor': 'error',
  'no-constant-binary-expression': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  eqeqeq: ['error', 'smart'],
  'no-template-curly-in-string': 'error',
};

const typeCheckedRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  '@typescript-eslint/no-invalid-void-type': ['error', { allowAsThisParameter: true }],
  '@typescript-eslint/unbound-method': 'error',
};

const runtimeRestrictions = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['node:*'],
          message: 'Workers 运行时不能使用 Node 内置模块，Node 专用代码请放到 src/integrations/。',
        },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    {
      name: 'process',
      message: "Workers 运行时没有 process，请使用 `import { env } from 'cloudflare:workers'`。",
    },
    { name: 'Buffer', message: 'Workers 运行时没有 Node Buffer，请使用 Web 标准 API。' },
    { name: '__dirname', message: 'Workers 运行时没有 __dirname。' },
    { name: '__filename', message: 'Workers 运行时没有 __filename。' },
    { name: 'require', message: 'Workers 运行时使用 ESM，请使用 import。' },
    { name: 'global', message: 'Workers 运行时没有 Node global，请使用 globalThis。' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "CallExpression[callee.property.name='get'] > Literal[value=/^(cf-connecting-ip|x-forwarded-for)$/i]",
      message: '请统一使用 getClientIp(request)（@/lib/client-ip）读取客户端 IP。',
    },
    {
      selector:
        "MemberExpression[property.name='env'][object.property.name='runtime'][object.object.property.name='locals']",
      message: "请使用 `import { env } from 'cloudflare:workers'`，不要使用 Astro.locals.runtime.env。",
    },
  ],
};

export default [
  {
    ignores: [
      '.astro/**',
      'dist/**',
      'drizzle/**',
      'node_modules/**',
      'public/**',
      'worker-configuration.d.ts',
    ],
  },
  ...eslintPluginAstro.configs['flat/recommended'],
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['**/*.astro/*'],
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      ...tsRecommendedRules,
      ...projectRules,
      ...typeCheckedRules,
      ...runtimeRestrictions,
    },
  },
  {
    files: ['src/**/*.astro'],
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: {
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.astro'],
      },
    },
    rules: {
      ...tsRecommendedRules,
      ...projectRules,
      ...runtimeRestrictions,
      '@typescript-eslint/naming-convention': astroNamingConvention,
    },
  },
  {
    // Astro processor 把内联 <script> 抽成虚拟 .ts/.js 块；这是浏览器代码，
    // 不能套用 Workers 运行时约束，也没有 tsconfig 项目信息。
    files: ['**/*.astro/*.js', '**/*.astro/*.ts'],
    plugins: { '@typescript-eslint': tseslint },
    languageOptions: {
      globals: {
        $: 'readonly',
        HyperDown: 'readonly',
        Markdown: 'readonly',
        DOMPurify: 'readonly',
        Typecho: 'readonly',
        reloadScroll: 'writable',
        scrollableEditor: 'readonly',
      },
    },
    rules: {
      ...tsRecommendedRules,
      ...projectRules,
      '@typescript-eslint/naming-convention': astroNamingConvention,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^(_|TypechoComment)$',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // 历史内联脚本依赖 var 的函数作用域与提升语义，暂不做批量改写。
      'no-var': 'off',
      'no-undef': 'error',
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/integrations/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['src/lib/client-ip.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['src/**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // 测试会执行插件内联客户端脚本，并使用含 ${...} 的模板源码断言。
      'no-new-func': 'off',
      'no-template-curly-in-string': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='only']", message: '提交前移除 .only。' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/naming-convention': 'off',
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
];
