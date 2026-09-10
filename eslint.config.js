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

        /*
         * DEFERRED FOCUS. Five separate bugs in this repository have come from
         * this one shape, and they were found one at a time over months
         * because each looked like a different bug.
         *
         * A focus move deferred past the end of the task that asked for it -
         * to a `requestAnimationFrame`, a `setTimeout`, or the post-paint half
         * of a `useEffect` - lands in the middle of whatever the user did
         * next, and takes focus off whatever they had just put it on. Nothing
         * throws. Text struck in that window goes to the element that used to
         * have focus, and there is no error for a keystroke that lands
         * nowhere, so the symptom is always something else: a palette that
         * opens missing the first letters of the word, an Enter that lands on
         * "Close" and swallows what follows, a keyboard-built pipeline that
         * comes out wired backwards because an arrow key acted on the node the
         * palette had just added. All four of those were real here.
         *
         * `useLayoutEffect` runs synchronously after the commit, inside the
         * task the keystroke started, so there is no window to lose. That is
         * the fix in every one of the five cases, and it is the only reason
         * those effects are layout effects - see the long note on `Enter` into
         * the inspector in Canvas.tsx.
         */
        {
          selector:
            ":matches(CallExpression[callee.name='requestAnimationFrame'], CallExpression[callee.property.name='requestAnimationFrame'], CallExpression[callee.name='setTimeout'], CallExpression[callee.property.name='setTimeout'], CallExpression[callee.name='useEffect']) CallExpression[callee.property.name='focus']",
          message:
            'Focus moved after the task that asked for it steals focus from whatever the user did next, silently. Use useLayoutEffect, which runs inside that task. See the note in eslint.config.js.',
        },
      ],
    },
  },

  /*
   * One place configures Zod.
   *
   * `src/lib/zod.ts` sets `jitless: true`, without which Zod compiles schemas
   * with `new Function` on first parse and trips our CSP in every browser.
   * A new file importing 'zod' directly would silently opt out of that, so it
   * is a lint error rather than something to remember.
   *
   * Type-only imports are exempt: they are erased before the code runs and
   * cannot reach the runtime configuration at all.
   */
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/zod.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: "Import { z } from '@/lib/zod' so the jitless configuration applies.",
              allowTypeImports: true,
            },
          ],
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

      // The inspector's size handle is the ARIA window-splitter pattern: a
      // FOCUSABLE separator, which is a widget rather than a decoration. It is
      // built on a real <button> so that focus, activation and the tab order
      // are the browser's rather than hand-rolled, and the rule cannot tell a
      // focusable separator from a static one. Every other interactive element
      // given a non-interactive role is still caught.
      'jsx-a11y/no-interactive-element-to-noninteractive-role': [
        'error',
        { button: ['separator'] },
      ],
    },
  },

  // --- Config files that run in Node ------------------------------------------
  {
    files: ['**/*.js'],
    languageOptions: { globals: globals.node },
    extends: [tseslint.configs.disableTypeChecked],
  },

  // --- The service worker -----------------------------------------------------
  // Not Node and not a window: its own global scope, with `self`, `caches` and
  // the rest. Listed explicitly rather than lumped in with the browser files,
  // because `window` genuinely does not exist here.
  {
    files: ['vite/service-worker.js'],
    languageOptions: { globals: globals.serviceworker },
  },

  // Must stay last: switches off every rule Prettier already handles, so the
  // formatter and the linter can never disagree about the same line.
  prettierConfig,
);
