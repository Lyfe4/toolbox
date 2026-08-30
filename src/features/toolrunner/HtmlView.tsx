import { useId, useState } from 'react';

import { Button } from '@/components/Button';
import { CopyIcon } from '@/components/Icon';
import { TextArea } from '@/components/TextArea';

import styles from './html.module.css';

/**
 * Writes HTML to the clipboard as BOTH `text/html` and `text/plain`.
 *
 * Two flavours in one write, so pasting into Word or Google Docs keeps the
 * formatting and pasting into an editor gives the markup. That is what the
 * async Clipboard API's `ClipboardItem` is for; `writeText` can only ever
 * carry one flavour, which is why the plain Copy button beside this one still
 * exists rather than being replaced by it.
 *
 * Returns a reason rather than throwing, because every failure here is
 * something the user needs told: an old browser, a denied permission, or a
 * gesture the browser did not consider user-initiated.
 */
export type RichCopyResult = { ok: true } | { ok: false; reason: string };

export async function copyRichText(html: string, plain: string): Promise<RichCopyResult> {
  /*
   * Feature-detected, not assumed, and not version-sniffed. Firefox shipped
   * `ClipboardItem` considerably later than Chrome and Safari, and a build
   * that predates it has `navigator.clipboard.write` missing rather than
   * failing - so the check covers both the constructor and the method.
   *
   * An `in` check rather than `?.`, because the DOM types declare
   * `navigator.clipboard` as always present and the linter believes them. It
   * is not: the whole API is absent in an insecure context, which is exactly
   * the case this branch exists for.
   */
  if (
    typeof ClipboardItem === 'undefined' ||
    !('clipboard' in navigator) ||
    typeof navigator.clipboard.write !== 'function'
  ) {
    return {
      ok: false,
      reason: 'This browser cannot put formatted text on the clipboard. Use Copy for the markup.',
    };
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      }),
    ]);
    return { ok: true };
  } catch (error) {
    // NotAllowedError is the common one: permission denied, or the click was
    // not treated as a user gesture.
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'The browser refused clipboard access.'
          : 'Could not write formatted text to the clipboard.',
    };
  }
}

export interface HtmlViewProps {
  readonly html: string;
  readonly label: string;
  readonly baseFilename: string;
  readonly onCopy: (text: string) => void;
  readonly onCopyRich: (html: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
}

/**
 * HTML output: the source, or a rendered preview of it.
 *
 * SOURCE IS THE DEFAULT. This is a developer tool and the markup is what most
 * people came for; a preview that has to be dismissed before you can read the
 * output would be in the way.
 */
export function HtmlView({
  html,
  label,
  baseFilename,
  onCopy,
  onCopyRich,
  onDownload,
}: HtmlViewProps) {
  const [preview, setPreview] = useState(false);
  const statusId = useId();

  return (
    <div className={styles.stack}>
      <div className={styles.toggle} role="group" aria-label={`${label} view`}>
        <Button
          size="sm"
          variant={preview ? 'ghost' : 'primary'}
          aria-pressed={!preview}
          onClick={() => {
            setPreview(false);
          }}
        >
          Source
        </Button>
        <Button
          size="sm"
          variant={preview ? 'primary' : 'ghost'}
          aria-pressed={preview}
          onClick={() => {
            setPreview(true);
          }}
        >
          Preview
        </Button>
        {/*
          The toggle is two aria-pressed buttons, which a screen reader already
          announces as pressed or not. This says which view is showing in
          words as well, because "Preview, pressed" describes the CONTROL and
          this describes the RESULT.
        */}
        <span className={styles.status} id={statusId} role="status">
          {preview ? 'Showing rendered preview' : 'Showing HTML source'}
        </span>
      </div>

      {preview ? (
        <iframe
          className={styles.preview}
          /*
           * THE SANDBOX.
           *
           * `sandbox=""` - the empty string, not a missing attribute - applies
           * every restriction there is. No allow-scripts, so nothing in the
           * document runs; no allow-same-origin, so it is a unique opaque
           * origin that cannot reach this page's DOM, storage or cookies even
           * if something did run.
           *
           * The two together matter more than either alone: allow-scripts
           * WITH allow-same-origin would let framed content remove its own
           * sandbox attribute from the parent, which is the classic escape.
           * Neither is present here, so that is not reachable.
           */
          sandbox=""
          /*
           * srcdoc rather than a blob: URL. The document is inline, so there
           * is no URL to leak, nothing to revoke, and no request - which keeps
           * it inside `connect-src 'none'` without an exception.
           *
           * What goes in is the SANITISED html the tool produced, never the
           * raw input. The tool sanitises on the way out; this renders that
           * output and nothing else.
           */
          srcDoc={html}
          /*
           * A rendered document needs a name a screen reader can announce, or
           * it is an unlabelled frame the user must enter to identify.
           */
          title={`${label} preview`}
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : (
        <TextArea
          className={styles.source}
          aria-label={label}
          value={html}
          readOnly
          spellCheck={false}
        />
      )}

      <div className={styles.row}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onCopy(html);
          }}
        >
          Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onCopyRich(html);
          }}
        >
          <CopyIcon size={12} /> Copy as rich text
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDownload(
              new Blob([html], { type: 'text/html;charset=utf-8' }),
              `${baseFilename}.html`,
            );
          }}
        >
          Download
        </Button>
        <span className={styles.hint}>{html.length} characters</span>
      </div>
    </div>
  );
}
