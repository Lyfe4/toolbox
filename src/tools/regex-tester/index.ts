import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';

import { flagsFor, regexDefaultOptions, regexOptionFields, regexOptionsSchema } from './options';
import { compilePattern, runRegex, toJson, toSummary } from './run';

/**
 * Test a regular expression against some text.
 *
 * Runs in a worker with a short timeout, because a user-supplied pattern can
 * backtrack catastrophically and there is no way to interrupt the engine from
 * inside. See the long note at the top of run.ts. `timeoutMessage` is what the
 * user sees when that fires, and it names the real cause.
 */
export const regexTesterTool = defineTool({
  id: 'regex-tester',
  name: 'Regex',
  summary: 'Test a regular expression against text, with groups and replacement.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      label: 'Subject',
      types: ['text'],
      required: true,
      description: 'The text to search. The pattern itself is an option.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Result',
      types: ['text'],
      description: 'The replaced text, or a list of matches with their offsets.',
    },
    { id: 'matches', label: 'Matches', types: ['json'] },
  ],

  optionsSchema: regexOptionsSchema,
  defaultOptions: regexDefaultOptions,
  optionFields: regexOptionFields,

  execution: {
    strategy: 'worker',
    requiresWasm: false,
    wasmModules: [],
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    /*
     * Two seconds. Short on purpose: any pattern worth using on a few hundred
     * kB finishes in milliseconds, so a run that reaches two seconds is
     * overwhelmingly a backtracking blow-up rather than honest work. Waiting
     * thirty seconds to say so would just be thirty seconds of a dead tab.
     */
    timeoutMs: 2_000,
    timeoutMessage:
      'That pattern is too slow on this input and was stopped. It is almost certainly backtracking catastrophically - nested quantifiers like (a+)+ are the usual cause.',
    maxInputBytes: 4 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    const compiled = compilePattern(options.pattern, flagsFor(options));
    if (!compiled.ok) return compiled;

    const report = runRegex(
      compiled.value,
      inputs.input.text,
      options.mode === 'replace' ? options.replacement : null,
    );

    return ok({
      output: {
        type: 'text',
        text: report.replaced ?? toSummary(report),
      } as const,
      matches: { type: 'json', data: toJson(report) } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(regexTesterTool);
export default erased;
