import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

// Cross-module literal-path patterns (belt; eslint-plugin-boundaries below is the
// braces — it resolves real paths, including relative imports).
const crossModulePatterns = [
  {
    group: ['**/modules/*/repository', '**/modules/*/service'],
    message: 'Cross-module access goes through index.public.ts.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      'docs/**',
      'docker/**',
      '.remember/**',
      '.claude/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        },
      },
      // Order matters: first match wins, so the repository file-element must
      // precede the module folder-element that contains it.
      'boundaries/elements': [
        {
          type: 'repository',
          mode: 'file',
          pattern: 'apps/api/src/modules/*/repository.ts',
          capture: ['name'],
        },
        { type: 'module', mode: 'folder', pattern: 'apps/api/src/modules/*', capture: ['name'] },
        { type: 'domain', pattern: 'packages/domain' },
        { type: 'db', pattern: 'packages/db' },
        { type: 'contracts', pattern: 'packages/contracts' },
      ],
    },
    rules: {
      // ARCHITECTURE §4.1 — the module graph. Adding an edge means adding it
      // here, in a PR that says why. Never a local eslint-disable.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'domain', allow: [] },
            { from: 'db', allow: ['domain'] },
            { from: 'contracts', allow: ['domain'] },
            {
              from: 'repository',
              allow: [
                'db',
                'domain',
                'contracts',
                ['module', { name: '${from.name}' }],
              ],
            },
            {
              from: 'module',
              allow: [
                'domain',
                'contracts',
                ['module', { name: '${from.name}' }],
                ['repository', { name: '${from.name}' }],
              ],
            },
          ],
        },
      ],
      'no-restricted-imports': ['error', { patterns: crossModulePatterns }],
    },
  },
  {
    // Only repository.ts may import @talon/db. Rules replace (not merge) per
    // block, so this repeats the cross-module patterns.
    files: ['apps/api/**/*.ts'],
    ignores: ['**/repository.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...crossModulePatterns,
            {
              group: ['@talon/db', '@talon/db/*'],
              message: 'Only repository.ts may import @talon/db.',
            },
          ],
        },
      ],
    },
  },

  // ── UI stream additions ─────────────────────────────────────────────────────
  // Next's build output and its generated ambient types are not ours to lint.
  { ignores: ['apps/web/.next/**', 'apps/web/next-env.d.ts', 'apps/web/public/**'] },

  // No raw color outside packages/tokens (spec 001 §7.1).
  // Scoped to apps/web rather than the whole repo on purpose. Widening it today
  // would fail on `users.avatarColor` in packages/db, which stores hex per user —
  // a real conflict with DESIGN_SYSTEM §3 (avatar fills come from a hash over the
  // token palette), but one that belongs to the schema owner, not to a lint config
  // landing mid-stream. Widen once that column is resolved.
  // Tailwind arbitrary values (`bg-[#fff]`) are string literals, so they are caught
  // here; hex inside .css is covered by apps/web/src/test/token-usage.test.ts,
  // which ESLint cannot parse.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#(?:[0-9a-fA-F]{3,4}){1,2}(?![0-9a-fA-F])/]',
          message:
            'Raw hex color. Use a semantic token — --color-action-primary-bg, never --color-indigo-600 and never #4C56C8.',
        },
        {
          selector: 'TemplateElement[value.raw=/#(?:[0-9a-fA-F]{3,4}){1,2}(?![0-9a-fA-F])/]',
          message:
            'Raw hex color. Use a semantic token — --color-action-primary-bg, never --color-indigo-600 and never #4C56C8.',
        },
      ],
    },
  },
);
