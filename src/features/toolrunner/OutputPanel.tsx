import { Button } from '@/components/Button';
import { ErrorIcon } from '@/components/Icon';
import { TextArea } from '@/components/TextArea';
import type { OutputPort, ToolError, ToolValue } from '@/features/registry/types';
import { formatBytes, sniffBytes } from '@/lib/sniff';

import { ColorView } from './ColorView';
import { DiffView } from './DiffView';
import { HtmlView } from './HtmlView';
import { ImageView, isPreviewableImage, type ImageComparison } from './ImageView';
import { JwtView } from './JwtView';
import { RegexView } from './RegexView';
import { ReportView } from './ReportView';
import styles from './runner.module.css';

/* -------------------------------------------------------------------------- *
 * Errors
 * -------------------------------------------------------------------------- */

export function ErrorReport({ error }: { readonly error: ToolError }) {
  return (
    <div className={styles.error}>
      <p className={styles.errorHead}>
        <ErrorIcon size={14} />
        {error.message}
      </p>

      <p className={styles.errorMeta}>
        <span>Code: {error.code}</span>
        {/* Position is what turns "invalid JSON" into something actionable. */}
        {error.position ? (
          <span>
            Line {error.position.line}, column {error.position.column}
          </span>
        ) : null}
      </p>

      {error.detail !== undefined ? <p className={styles.errorDetail}>{error.detail}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Output
 * -------------------------------------------------------------------------- */

/** A short, safe preview of decoded bytes. Never rendered as markup. */
function previewOf(bytes: Uint8Array): string {
  const slice = bytes.subarray(0, 2048);
  // Non-fatal decode: binary output should still show something rather than
  // refusing, and replacement characters are honest about what it is.
  const text = new TextDecoder('utf-8').decode(slice);
  return bytes.length > slice.length ? `${text}…` : text;
}

export interface OutputViewProps {
  readonly value: ToolValue;
  readonly label: string;
  readonly baseFilename: string;
  /** The port's rendering hint, when it declared one. See OutputPort. */
  readonly presentation?: OutputPort['presentation'];
  readonly onCopy: (text: string) => void;
  /** Writes both text/html and text/plain. Only ever called for HTML output. */
  readonly onCopyRich: (html: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
  /**
   * The image this run was given, when it was given one.
   *
   * Only the image preview reads it, and only to draw the before-and-after —
   * judging a lossy conversion means comparing, and the numbers in the report
   * cannot tell you whether quality 0.6 is acceptable for THIS picture. It is
   * a fact about the run rather than about the value, which is why it is a
   * separate prop rather than something smuggled into `value`; every other
   * branch ignores it.
   */
  readonly comparison?: ImageComparison | null;
}

export function OutputView({
  value,
  label,
  baseFilename,
  presentation,
  onCopy,
  onCopyRich,
  onDownload,
  comparison = null,
}: OutputViewProps) {
  // The hint is checked before the type switch, because it exists precisely
  // for values whose data type does not determine how to draw them.
  if (presentation === 'diff' && value.type === 'json') {
    return (
      <DiffView
        value={value.data}
        label={label}
        baseFilename={baseFilename}
        onCopy={onCopy}
        onDownload={onDownload}
      />
    );
  }

  // The regex report is JSON for the same reason the diff is: a screen reader
  // needs the matches as structure. The hint says which of the two it is.
  if (presentation === 'regex' && value.type === 'json') {
    return (
      <RegexView
        value={value.data}
        label={label}
        baseFilename={baseFilename}
        onCopy={onCopy}
        onDownload={onDownload}
      />
    );
  }

  /*
   * The signature verdict, first and unmissable, then the claims.
   *
   * Same bargain as the others and for a sharper reason: the tool's most
   * important sentence - "NOT VERIFIED - no key supplied" - was a string value
   * among other string values in a textarea, one line above a header object
   * nobody scrolls past. An unverified decode presented as ordinary is the
   * actual security risk with a JWT tool. See JwtView.
   */
  if (presentation === 'jwt' && value.type === 'json') {
    return (
      <JwtView
        value={value.data}
        label={label}
        baseFilename={baseFilename}
        onCopy={onCopy}
        onDownload={onDownload}
      />
    );
  }

  /*
   * A conversion report: the notes that matter, then the before-and-after
   * facts. Same bargain again - the payload is ordinary JSON for anything
   * downstream, and the hint says it is a report rather than a data structure
   * somebody wants to read as braces.
   */
  if (presentation === 'report' && value.type === 'json') {
    return (
      <ReportView
        value={value.data}
        label={label}
        baseFilename={baseFilename}
        onCopy={onCopy}
        onDownload={onDownload}
      />
    );
  }

  // A port that declares it carries HTML gets the preview and the rich-text
  // copy. Declared on the port rather than sniffed from the string, so the
  // affordance is a fact about the tool rather than a guess about its output.
  if (presentation === 'html' && value.type === 'text') {
    return (
      <HtmlView
        html={value.text}
        label={label}
        baseFilename={baseFilename}
        onCopy={onCopy}
        onCopyRich={onCopyRich}
        onDownload={onDownload}
      />
    );
  }

  switch (value.type) {
    case 'text':
      return (
        <div className={styles.stack}>
          <TextArea
            className={styles.editor}
            aria-label={label}
            value={value.text}
            readOnly
            spellCheck={false}
          />
          <div className={styles.row}>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onCopy(value.text);
              }}
            >
              Copy
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onDownload(
                  new Blob([value.text], { type: 'text/plain;charset=utf-8' }),
                  `${baseFilename}.txt`,
                );
              }}
            >
              Download
            </Button>
            <span className={styles.hint}>{value.text.length} characters</span>
          </div>
        </div>
      );

    case 'bytes': {
      /*
       * AN IMAGE IS SHOWN, NOT DESCRIBED.
       *
       * "Binary output. Download it rather than trying to read it here." is
       * true of a ZIP and false of a PNG, and it was what the image converter
       * said about every result it produced. The sniff already ran to decide
       * between a text preview and that sentence; asking it one more question
       * costs nothing and turns the one tool whose output is a picture into a
       * tool that shows you the picture.
       *
       * Keyed on the SNIFF rather than on a port hint, so base64's decoded
       * output gets it too - decoding a `data:` URI and seeing the image is a
       * real thing people do with that tool.
       */
      if (isPreviewableImage(value.bytes)) {
        return (
          <ImageView
            bytes={value.bytes}
            label={label}
            filename={value.filename ?? `${baseFilename}.bin`}
            comparison={comparison}
            onDownload={onDownload}
          />
        );
      }

      const sniff = sniffBytes(value.bytes);
      return (
        <div className={styles.stack}>
          <div className={styles.binarySummary}>
            <p className={styles.spread}>
              <span className={styles.mono}>{sniff.label}</span>
              <span className={styles.hint}>{formatBytes(value.bytes.byteLength)}</span>
            </p>
            {sniff.isProbablyText ? (
              <pre className={styles.preview}>{previewOf(value.bytes)}</pre>
            ) : (
              <p className={styles.hint}>
                Binary output. Download it rather than trying to read it here.
              </p>
            )}
          </div>
          <div className={styles.row}>
            {sniff.isProbablyText ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onCopy(new TextDecoder('utf-8').decode(value.bytes));
                }}
              >
                Copy as text
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                onDownload(
                  new Blob([value.bytes], { type: sniff.mediaType ?? 'application/octet-stream' }),
                  value.filename ?? `${baseFilename}.bin`,
                );
              }}
            >
              Download
            </Button>
          </div>
        </div>
      );
    }

    case 'json':
      return (
        <OutputView
          value={{ type: 'text', text: JSON.stringify(value.data, null, 2) }}
          label={label}
          baseFilename={baseFilename}
          onCopy={onCopy}
          onCopyRich={onCopyRich}
          onDownload={onDownload}
        />
      );

    case 'color':
      return <ColorView color={value.color} label={label} />;

    case 'image':
    case 'datetime':
      // Declared in the type system, but no tool produces one yet. Saying so is
      // better than rendering nothing and looking broken.
      return <p className={styles.hint}>No viewer for {value.type} output yet.</p>;
  }
}
