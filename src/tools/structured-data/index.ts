import { defineTool, eraseTool, ok, type ErasedTool } from '@/features/registry/types';
import { noted, type ToolNote } from '@/lib/notes';
import { hasByteOrderMark } from '@/lib/text';

import {
  checkJsonInput,
  decodeDocument,
  DELIMITERS,
  formatNamedBy,
  readAuto,
  readSource,
  sortKeysDeep,
  writeTarget,
  type Reading,
} from './convert';
import { structuredDataMeta } from './meta';
import {
  structuredDataDefaultOptions,
  structuredDataOptionFields,
  structuredDataOptionsSchema,
} from './options';
import { buildReport } from './report';

/**
 * A value that arrived already parsed, as a `Reading`.
 *
 * The `json` port skips the parser, so there is no format to report and no
 * document count to carry. It still goes through `checkJsonInput`, which is the
 * one route into this tool whose shape nothing else has looked at.
 */
function wired(checked: ReturnType<typeof checkJsonInput>): ReturnType<typeof readAuto> {
  if (!checked.ok) return checked;
  const reading: Reading = {
    data: checked.value,
    format: 'json',
    delimiter: null,
    documents: 1,
    notes: [],
  };
  return ok(reading);
}

/**
 * Convert between JSON, YAML, CSV and TSV.
 *
 * This tool exists to prove three things about the design:
 *
 *   1. Options that genuinely change behaviour, including auto-detection.
 *   2. Parse failures reported as structured errors with a line and column,
 *      never thrown across the execution boundary.
 *   3. Multiple outputs from one run - the rendered document and the parsed
 *      structure, so the canvas can wire either onward.
 */
export const structuredDataTool = defineTool({
  ...structuredDataMeta,

  optionsSchema: structuredDataOptionsSchema,
  defaultOptions: structuredDataDefaultOptions,
  optionFields: structuredDataOptionFields,

  run: ({ inputs, options }) => {
    const { input } = inputs;
    const delimiter = DELIMITERS[options.delimiter];

    // A wired-in 'json' value is already parsed. Bytes are decoded strictly -
    // see `decodeDocument` for why UTF-16 with a byte order mark is the one
    // encoding other than UTF-8 that gets through.
    let source: string;
    /*
     * Notes about the INPUT, before either half of the conversion. Only one so
     * far, and it is the one difference the wire-versus-clipboard audit found:
     * a byte order mark is removed when bytes are decoded at a document port
     * and kept when the same document is typed into the box, so one file has
     * two answers depending on how it arrived. It stays removed - it is a
     * declaration about the encoding, not a character, and leaving it in front
     * of `{` breaks every parser downstream - and now it is said.
     */
    const inputNotes: ToolNote[] = [];
    if (input.type === 'json') {
      source = '';
    } else if (input.type === 'bytes') {
      if (hasByteOrderMark(input.bytes)) {
        inputNotes.push(
          noted(
            'A byte order mark was removed',
            'The file began with a BOM, which declares the encoding rather than being part of the document. It is dropped when the bytes are decoded, here and at every other document port. Pasting the same file into the box keeps it, because nothing decodes anything there.',
          ),
        );
      }
      const decoded = decodeDocument(input.bytes);
      if (!decoded.ok) return decoded;
      source = decoded.value;
    } else {
      source = input.text;
      if (source.charCodeAt(0) === 0xfeff) {
        inputNotes.push(
          noted(
            'A byte order mark was ignored',
            'The text begins with U+FEFF. It is skipped before parsing, because every format here would otherwise refuse the character in front of the first token, and it is not in the output.',
          ),
        );
      }
    }

    /*
     * A value wired in on the `json` port is already parsed, so it skips the
     * parser - but NOT the guards. It is the one route into this tool whose
     * shape nothing in this file has checked, and `sortKeysDeep` and
     * `JSON.stringify` are both recursive: a value nested a few thousand deep
     * threw `RangeError` straight out of `run`, which the execution contract
     * says can never happen.
     */
    /*
     * THE NAME OF A FILE, for the one question content cannot answer - see
     * `readByName`. Only a `bytes` value has one: text was typed or pasted, and
     * a wired `json` value was never a file.
     */
    const filename = input.type === 'bytes' ? input.filename : null;
    const parsed: ReturnType<typeof readAuto> =
      input.type === 'json'
        ? wired(checkJsonInput(input.data))
        : options.source === 'auto'
          ? readAuto(source, delimiter, options.target, formatNamedBy(filename))
          : readSource(source, options.source, delimiter, options.target);

    if (!parsed.ok) return parsed;

    const reading = parsed.value;
    const data = options.sortKeys ? sortKeysDeep(reading.data) : reading.data;

    const rendered = writeTarget(data, options.target, {
      indent: options.indent,
      delimiter,
      // So a `---` stream comes back out as a stream rather than as a sequence.
      // See `writeTarget`; the guard that keeps it honest is there.
      documents: reading.documents,
    });
    if (!rendered.ok) return rendered;

    const targetDelimiter =
      options.target === 'tsv' ? DELIMITERS.tab : options.target === 'csv' ? delimiter : null;

    return ok({
      output: { type: 'text', text: rendered.value.text } as const,
      data: { type: 'json', data } as const,
      report: {
        type: 'json',
        data: buildReport({
          reading,
          target: options.target,
          targetDelimiter,
          // A value arriving on the `json` port was never detected and never
          // read from a format, so the report says JSON rather than claiming a
          // guess it did not make.
          chosen: input.type === 'json' || options.source !== 'auto',
          filename,
          writeNotes: rendered.value.notes,
          wroteStream: rendered.value.stream,
          inputNotes,
        }),
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(structuredDataTool);
export default erased;
