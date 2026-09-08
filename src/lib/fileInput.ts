import type { Bytes, InputPort, ToolValue } from '@/features/registry/types';

import { formatBytes, sniffBytes, type SniffResult } from './sniff';
import { decodeDocument } from './text';

/**
 * A FILE ARRIVING AT AN INPUT PORT.
 *
 * One implementation, used by the tool runner and by the canvas inspector. It
 * lived inside `ToolRunner.tsx` while the runner was the only route that could
 * take a file; the canvas now can too, and a second copy of these rules is the
 * drift the [port audit](../../docs/architecture.md#the-port-set) was about -
 * one tool that accepts a file in one place and refuses it in the other.
 *
 * THE DECLARED MIME TYPE IS NEVER READ. `file.type` comes from the operating
 * system's extension mapping: rename `payload.exe` to `notes.json` and the
 * browser reports `application/json`. Every decision here is made from the
 * bytes, through `sniffBytes` - the same rule the rest of the app follows.
 */

/**
 * How much of a file the sniff actually needs.
 *
 * `sniffBytes` matches signatures in the first twelve bytes and examines the
 * first 4 kB for its is-this-text heuristic, so a slice this long gives a
 * byte-identical `SniffResult` to the whole file. That matters because it is
 * what lets a 64 MB binary be refused by a text-only port without having been
 * read into memory first - asserted by `fileInput.test.ts`.
 */
export const SNIFF_WINDOW_BYTES = 4096;

/**
 * A file that has been read, sniffed and accepted for a specific port.
 *
 * `value` is built here rather than at run time, and that is the point: a
 * `LoadedFile` cannot exist unless the port can actually use it, so no route
 * has to re-check and none can forget to. The raw bytes are deliberately not
 * kept beside it - for a `bytes` port `value` holds the very same buffer, and
 * for a text port keeping both would retain the file twice over.
 */
export interface LoadedFile {
  readonly file: File;
  readonly sniff: SniffResult;
  /** What this file becomes on the port it was chosen for. */
  readonly value: ToolValue;
}

export type FileValue = { readonly value: ToolValue } | { readonly error: string };

/**
 * Whether a port can use a file at all, from the sniff alone.
 *
 * Split out from `fileValueFor` so the answer is available BEFORE the file has
 * been read: a port that takes only text has no use for a PNG whatever its
 * contents turn out to be, and reading 64 MB in order to say so is the one
 * mistake a file control can make that a user actually feels.
 */
export function sniffRejection(port: InputPort, sniff: SniffResult): string | null {
  if (port.types.includes('bytes')) return null;

  if (port.types.includes('text')) {
    return sniff.isProbablyText
      ? null
      : `That file looks like ${sniff.label.toLowerCase()}, and ${port.label} needs text.`;
  }

  /*
   * Unreachable for the current port set - every input port declares `text` or
   * `bytes` - and kept because it is the honest answer for a port that
   * declares neither. A future `color`-only or `json`-only input would get a
   * sentence rather than silently receiving text it never asked for.
   */
  return `${port.label} takes ${port.types.join(' or ')}, which cannot come from a file.`;
}

/**
 * The value a file becomes on a port, or why it cannot become one.
 *
 * A `bytes` port gets the buffer and the SNIFFED media type. A text-only port
 * gets the file decoded through `decodeDocument` - strict UTF-8, with a UTF-16
 * byte order mark as the one exception - which is the same decoder the wire
 * path uses. It was a lenient `TextDecoder` here and a strict one on a wire, so
 * a Latin-1 file dropped on a tool page was processed as replacement
 * characters while the identical bytes arriving from a base64 node were
 * refused: one tool, two answers, decided by which route the bytes took.
 */
export function fileValueFor(
  port: InputPort,
  file: File,
  bytes: Bytes,
  sniff: SniffResult,
): FileValue {
  const rejection = sniffRejection(port, sniff);
  if (rejection !== null) return { error: rejection };

  if (port.types.includes('bytes')) {
    return {
      value: {
        type: 'bytes',
        bytes,
        // The sniffed type, never the one the file declared.
        mediaType: sniff.mediaType,
        filename: file.name,
      },
    };
  }

  const decoded = decodeDocument(bytes, `"${file.name}"`);
  if (!decoded.ok) {
    const { message, detail } = decoded.error;
    return { error: detail === undefined ? message : `${message} ${detail}` };
  }
  return { value: { type: 'text', text: decoded.value } };
}

/**
 * What a file has to fit inside.
 *
 * `maxInputBytes` is a limit on a tool's WHOLE input, not on one file, and for
 * `diff` its README says so explicitly - 8 MB across both ports. Checking only
 * the file being chosen would therefore let two 5 MB files be accepted one at a
 * time and refused together by the engine at run time, which is precisely the
 * after-the-fact refusal a selection-time check exists to avoid.
 */
export interface SizeBudget {
  /** The tool's whole-input limit, from its manifest entry. */
  readonly maxBytes: number;
  /**
   * What this node's OTHER inputs already contribute towards it.
   *
   * Both routes compute this with `measureInputs` - the very function the
   * engine weighs a run with - so the answer here and the answer there cannot
   * drift apart. Asserted by `fileInput.test.ts`.
   */
  readonly otherBytes?: number;
}

/**
 * Reads a file for a port, refusing it at the point of selection.
 *
 * Every refusal happens HERE rather than at run time, and each one names the
 * file and what to do about it. A size limit reported after the fact is a limit
 * the user discovers by waiting; a type refusal reported at run time is one
 * they discover by pressing a button that was never going to work.
 *
 * The order is deliberate and each step is cheaper than the one below it:
 *
 *   1. `size` against the tool's budget, before a single byte is read.
 *   2. The sniff window, to refuse a binary file on a text-only port.
 *   3. The whole file, and a strict decode where the port needs text.
 */
export async function loadFileForPort(
  port: InputPort,
  file: File,
  budget: SizeBudget,
): Promise<{ readonly loaded: LoadedFile } | { readonly error: string }> {
  const otherBytes = budget.otherBytes ?? 0;
  if (file.size + otherBytes > budget.maxBytes) {
    return {
      error:
        otherBytes === 0
          ? `"${file.name}" is ${formatBytes(file.size)}, over this tool's ${formatBytes(budget.maxBytes)} limit.`
          : `"${file.name}" is ${formatBytes(file.size)} and this node's other inputs already hold ${formatBytes(otherBytes)}, over this tool's ${formatBytes(budget.maxBytes)} limit.`,
    };
  }

  const head = new Uint8Array(await file.slice(0, SNIFF_WINDOW_BYTES).arrayBuffer());
  const sniff = sniffBytes(head);

  const early = sniffRejection(port, sniff);
  if (early !== null) return { error: early };

  // Split across two statements so the buffer is inferred as a plain
  // ArrayBuffer rather than ArrayBufferLike - see the note on `Bytes`.
  const buffer = await file.arrayBuffer();
  const bytes: Bytes = new Uint8Array(buffer);

  const built = fileValueFor(port, file, bytes, sniff);
  if ('error' in built) return { error: built.error };

  return { loaded: { file, sniff, value: built.value } };
}

/** `photo.png · 2.1 MB`, the one wording for a chosen file across both routes. */
export function describeFile(name: string, size: number): string {
  return `${name} · ${formatBytes(size)}`;
}
