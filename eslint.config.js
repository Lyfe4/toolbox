import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier/flat';
import importX from 'eslint-plugin-import-x';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Import ordering is shared by every file type, so it lives in one place.
const importOrderRule = [
  'error',
  {
    groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index'], 'type'],
    // `@/...` is our own source, not a third-party scoped package.
    pathGroups: [{ pattern: '@/**', group: 'internal' }],
    pathGroupsExcludedImportTypes: ['builtin'],
    'newlines-between': 'always',
    alphabetize: { order: 'asc', caseInsensitive: true },
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      // Written by the TanStack Router Vite plugin. Generated, so not ours to lint.
      'src/routeTree.gen.ts',
    ],
  },

  {
    // An `eslint-disable` comment that no longer suppresses anything is an
    // error. Stops stale suppressions from accumulating in the repo.
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },

  // --- Baseline for every linted file ---------------------------------------
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [js.configs.recommended],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': importOrderRule,
      'import-x/first': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/newline-after-import': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // --- TypeScript, with type-aware rules -------------------------------------
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      // `projectService` asks TypeScript itself which project a file belongs to,
      // instead of us hand-maintaining a list of tsconfigs here.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: globals.browser,
    },
    rules: {
      // Non-negotiables from the project brief. All three are already on via
      // strictTypeChecked; restated so their removal has to be deliberate.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',

      // Pairs with `verbatimModuleSyntax`: anything used only as a type must be
      // imported with `import type`, so it is guaranteed to vanish at build time.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Allow `void someAsyncCall()` as the explicit "I am not awaiting this" marker.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],

      // --- No code from strings, no HTML from strings ---------------------
      // Patchbay's whole security posture is that pasted input is DATA. These
      // rules keep it that way, and pair with the CSP: script-src has no
      // 'unsafe-inline' and no 'unsafe-eval', so most of this would fail at
      // runtime anyway - failing at lint time is a much better place to learn.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-restricted-properties': [
        'error',
        {
          property: 'innerHTML',
          message: 'Assigning innerHTML injects markup. Render through React instead.',
        },
        {
          property: 'outerHTML',
          message: 'Assigning outerHTML injects markup. Render through React instead.',
        },
        {
          property: 'insertAdjacentHTML',
          message: 'insertAdjacentHTML injects markup. Render through React instead.',
        },
        {
          object: 'document',
          property: 'write',
          message: 'document.write injects markup and blocks parsing.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'dangerouslySetInnerHTML defeats React escaping. Render the value as text.',
        },
        {
          selector: "NewExpression[callee.name='Function']",
          message: 'new Function is eval by another name.',
        },
        {
          selector: "CallExpression[callee.name='Function']",
          message: 'Function() is eval by another name.',
        },
      ],
    },
  },

  // --- React ------------------------------------------------------------------
  {
    files: ['**/*.tsx'],
    // `configs.flat` is the flat-config build of these presets; the top-level
    // `configs` entry is still the legacy eslintrc shape.
    extends: [reactHooks.configs.flat['recommended-latest'], jsxA11y.flatConfigs.strict],
    rules: {
      // The canvas is a role="application" widget and its nodes are focusable
      // role="group" elements. Both legitimately take tabIndex; `roles` is the
      // rule's own extension point for exactly this, and every other
      // non-interactive element is still caught.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['tabpanel', 'application', 'group'], allowExpressionValues: true },
      ],
    },
  },

  // --- Config files that run in Node ------------------------------------------
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Must stay last: switches off every rule Prettier already handles, so the
  // formatter and the linter can never disagree about the same line.
  prettierConfig,
);
