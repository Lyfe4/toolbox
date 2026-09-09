import { Button } from '@/components/Button';
import { TextArea } from '@/components/TextArea';
import type { JsonValue } from '@/features/registry/types';

import styles from './viewChrome.module.css';

/**
 * THE PAYLOAD ITSELF, COPYABLE AND DOWNLOADABLE.
 *
 * A view is a presentation of an output, never a replacement for it. Every
 * view that renders JSON as something other than JSON therefore has to hand
 * the JSON back, and the four that do it now do it identically rather than
 * three-times-similarly-and-once-not-at-all.
 *
 * Its own component rather than four copies for a reason beyond tidiness: the
 * `aria-label` convention ("<output name> raw") is what a test and a screen
 * reader both use to find this box, and four hand-written copies is four
 * chances for one of them to be labelled "Raw output" instead.
 */
export interface RawPayloadProps {
  /** The output's name. The box is labelled "<label> raw". */
  readonly label: string;
  readonly value: JsonValue;
  readonly baseFilename: string;
  readonly onCopy: (text: string) => void;
  readonly onDownload: (blob: Blob, filename: string) => void;
}

export function RawPayload({ label, value, baseFilename, onCopy, onDownload }: RawPayloadProps) {
  // Two spaces, the same as everywhere else the app prints JSON for a person.
  const json = JSON.stringify(value, null, 2);

  return (
    <>
      <TextArea
        className={styles.json}
        aria-label={`${label} raw`}
        value={json}
        readOnly
        spellCheck={false}
      />
      <div className={styles.actions}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onCopy(json);
          }}
        >
          Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDownload(
              new Blob([json], { type: 'application/json;charset=utf-8' }),
              `${baseFilename}.json`,
            );
          }}
        >
          Download
        </Button>
      </div>
    </>
  );
}
