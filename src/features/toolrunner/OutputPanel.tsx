import { Button } from '@/components/Button';
import { ErrorIcon } from '@/components/Icon';
import { TextArea } from '@/components/TextArea';
import type { OutputPort, ToolError, ToolValue } from '@/features/registry/types';
import { formatBytes, sniffBytes } from '@/lib/sniff';

import { ColorView } from './ColorView';
import { DiffView } from './DiffView';
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
  readonly onDownload: (blob: Blob, filename: string) => void;
}

export function OutputView({
  value,
  label,
  baseFilename,
  presentation,
  onCopy,
  onDownload,
}: OutputViewProps) {
  // The hint is checked before the type switch, because it exists precisely
  // for values whose data type does not determine how to draw them.
  if (presentation === 'diff' && value.type === 'json') {
    return <DiffView value={value.data} label={label} />;
  }

  switch (value.type) {
    case 'text':
      return (
        <div className={styles.stack}>
          <TextArea
            className={styles.output}
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
