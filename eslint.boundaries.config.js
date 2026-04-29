import tseslint from 'typescript-eslint'

const ignorePatterns = [
  '**/dist/**',
  '**/node_modules/**',
  '**/.nuxt/**',
  '**/.output/**',
]

const tsBase = {
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
}

function tsRuleConfig(files, rules) {
  return {
    files,
    ...tsBase,
    rules,
  }
}

export default [
  {
    ignores: ignorePatterns,
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },

  tsRuleConfig(['packages/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@axiom/core/src/*'],
            message:
              'Do not deep-import from @axiom/core/src. Use the public @axiom/core boundary exports.',
          },
        ],
      },
    ],
  }),

  // Core must stay platform-agnostic.
  tsRuleConfig(['packages/core/src/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@axiom/web-backend',
              '@axiom/web-backend/*',
              '@axiom/web-frontend',
              '@axiom/web-frontend/*',
              '@axiom/telegram',
              '@axiom/telegram/*',
            ],
            message:
              'packages/core must not depend on platform packages (web-backend, web-frontend, telegram).',
          },
        ],
      },
    ],
  }),

  // Frontend must not depend on backend/telegram internals.
  tsRuleConfig(['packages/web-frontend/app/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@axiom/web-backend',
              '@axiom/web-backend/*',
              '@axiom/telegram',
              '@axiom/telegram/*',
            ],
            message:
              'packages/web-frontend must not depend on backend or telegram package internals.',
          },
        ],
      },
    ],
  }),

  // Telegram package stays isolated from web package internals.
  tsRuleConfig(['packages/telegram/src/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '@axiom/web-backend',
              '@axiom/web-backend/*',
              '@axiom/web-frontend',
              '@axiom/web-frontend/*',
            ],
            message:
              'packages/telegram must stay isolated from web-backend and web-frontend internals.',
          },
        ],
      },
    ],
  }),

  // Lock canonical backend module entrypoints for migrated domains.
  tsRuleConfig(['packages/web-backend/src/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '**/routes/providers.js',
              '**/routes/settings.js',
              '**/routes/tasks.js',
              '**/routes/memory.js',
            ],
            message:
              'Use canonical backend module routes in src/api/modules/<domain>/route.js. Legacy route adapters are not allowed.',
          },
        ],
      },
    ],
  }),

  // Backend target structure: route -> controller -> service -> schema/mapper.
  tsRuleConfig(
    [
      'packages/web-backend/src/api/modules/**/route/**/*.ts',
      'packages/web-backend/src/api/modules/**/route.ts',
    ],
    {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/service',
                '**/service/**',
                '**/*.service',
                '**/schema',
                '**/schema/**',
                '**/*.schema',
                '**/mapper',
                '**/mapper/**',
                '**/*.mapper',
              ],
              message:
                'Route layer must not import service/schema/mapper directly. Route -> controller only.',
            },
          ],
        },
      ],
    },
  ),
  tsRuleConfig(
    [
      'packages/web-backend/src/api/modules/**/controller/**/*.ts',
      'packages/web-backend/src/api/modules/**/controller.ts',
    ],
    {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/route', '**/route/**', '**/*.route'],
              message: 'Controller layer must not import route layer.',
            },
          ],
        },
      ],
    },
  ),
  tsRuleConfig(
    [
      'packages/web-backend/src/api/modules/**/service/**/*.ts',
      'packages/web-backend/src/api/modules/**/service.ts',
    ],
    {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/route',
                '**/route/**',
                '**/*.route',
                '**/controller',
                '**/controller/**',
                '**/*.controller',
              ],
              message: 'Service layer must not import route/controller layers.',
            },
          ],
        },
      ],
    },
  ),
  tsRuleConfig(
    [
      'packages/web-backend/src/api/modules/**/schema/**/*.ts',
      'packages/web-backend/src/api/modules/**/schema.ts',
      'packages/web-backend/src/api/modules/**/mapper/**/*.ts',
      'packages/web-backend/src/api/modules/**/mapper.ts',
    ],
    {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/route',
                '**/route/**',
                '**/*.route',
                '**/controller',
                '**/controller/**',
                '**/*.controller',
                '**/service',
                '**/service/**',
                '**/*.service',
              ],
              message:
                'Schema/mapper layer must stay transport-focused and must not depend on route/controller/service layers.',
            },
          ],
        },
      ],
    },
  ),

  // Frontend target structure boundaries (for incoming refactor slices).
  tsRuleConfig(['packages/web-frontend/app/features/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['~/pages/**', '../pages/**', '../../pages/**'],
            message: 'Feature modules must not import page orchestrators.',
          },
        ],
      },
    ],
  }),
  tsRuleConfig(['packages/web-frontend/app/api/**/*.ts'], {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: [
              '~/pages/**',
              '~/features/**',
              '~/components/**',
              '../pages/**',
              '../features/**',
              '../components/**',
              '../../pages/**',
              '../../features/**',
              '../../components/**',
            ],
            message:
              'Frontend API layer must stay transport-focused and must not import pages/features/components.',
          },
        ],
      },
    ],
  }),
]
