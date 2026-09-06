import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import type { Bytes } from '@/features/registry/types';
import { formatBytes, sniffBytes } from '@/lib/sniff';

import styles from './image.module.css';
import { ViewToggle } from './ViewToggle';

/**
 * AN IMAGE YOU CAN ACTUALLY SEE.
 *
 * The image tool's output port is `bytes`, so the runner said "Binary output.
 * Download it rather than trying to read it here." and left it at that. That
 * sentence is true of a ZIP and false of the thing this tool exists to
 * produce: you converted an image, you set a quality of 0.6, and the only way
 * to find out what 0.6 looks like was to download the file and open it in
 * something else. A converter whose result you cannot look at has not
 * converted anything you can judge.
 *
 * WHY THE SNIFF DECIDES AND NOT A `presentation` HINT. The bytes branch
 * already sniffs — that is how it chooses between a text preview and the
 * binary summary — so this is the same question asked one step further:
 * what ARE these bytes. Doing it here rather than on the port also means
 * base64's decoded output gets the preview, which is a real thing people do
 * (paste a `data:` URI, decode it, see the image) and which a port-level hint
 * on the image tool alone would have missed. The declared `mediaType` is
 * ignored in favour of the sniffed one, the same rule the rest of the app
 * follows: bytes are believed, declarations are not.
 *
 * WHY COMPARE IS A VIEW AND NOT THE DEFAULT. Judging a lossy conversion means
 * comparing, so the source is offered beside the result whenever the page
 * still has it. It is not the default because at 320px two images side by side
 * are two images too small to judge anything by, and the question "what did I
 * just make" comes before "how does it differ".
 *
 * WHY THERE IS NO RAW STATE, when every other view has one. The raw payload
 * here is a file, not text. There is nothing to put in a textarea and nothing
 * to copy — so instead of a state you have to switch to, Download and the
 * sniffed facts are on screen in EVERY state. That is a stronger form of the
 * same guarantee, not an exemption from it.
 */

/**
 * Above this, no preview is created until the user asks for one.
 *
 * A preview costs a decoded bitmap: a 40-megapixel PNG is around 160 MB of
 * RGBA in the compositor whatever its file size, and the compare view holds
 * TWO of them. The limit is on the encoded bytes because that is the number
 * available before anything is decoded — an imperfect proxy for pixel count,
 * and the only one that can be checked for free.
 *
 * 8 MB passes every photograph anyone converts by hand and stops the 60 MB
 * scanner TIFF-sized PNG that would otherwise lock the tab up while a person
 * who only wanted the file size waits for a bitmap they were not going to
 * look at.
 */
const PREVIEW_LIMIT = 8 * 1024 * 1024;

/** Media types this view is willing to hand to an `<img>`. */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isPreviewableImage(bytes: Bytes): boolean {
  const sniff = sniffBytes(bytes);
  return sniff.mediaType !== null && PREVIEWABLE.has(sniff.mediaType);
}

/**
 * An <img> fed from a Blob, with the object URL owned by the element.
 *
 * THE OBJECT URL IS SET ON THE DOM NODE, not held in React state, and that is
 * the whole design rather than a stylistic preference:
 *
 *  - `URL.createObjectURL` is impure, so it cannot happen during a render.
 *  - Putting the result in state means `setState` inside an effect, which is a
 *    cascading render and something this codebase's lint rules refuse outright.
 *  - Setting `node.src` in an effect is the case effects are actually for -
 *    updating an external system - and the cleanup that revokes the URL is the
 *    same cleanup that would have to exist anyway.
 *
 * An object URL is a document-lifetime reference: it pins its blob until it is
 * revoked or the page goes away. Thirty conversions in one sitting with no
 * revoke is thirty images held with nothing on screen to explain the memory.
 * The cleanup runs on unmount AND whenever the blob changes, so a new result
 * releases the previous one.
 *
 * `useLayoutEffect` rather than `useEffect`, because `useEffect` runs after
 * paint - which is one painted frame of an <img> with no `src`, i.e. one frame
 * of broken-image alt text on every conversion.
 */
function BlobImage({
  blob,
  alt,
  className,
}: {
  readonly blob: Blob;
  readonly alt: string;
  readonly className: string | undefined;
}) {
  const ref = useRef<HTMLImageElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;

    const url = URL.createObjectURL(blob);
    node.src = url;

    return () => {
      URL.revokeObjectURL(url);
      // The element may outlive the URL by a render; a src pointing at a
      // revoked URL is a broken image rather than an empty one.
      node.removeAttribute('src');
    };
  }, [blob]);

  /*
   * `alt` describes what this image IS in this context - a preview of a
   * conversion - not what the picture depicts, which nothing here can know.
   * Empty alt would be wrong: the image is the content, not decoration.
   */

  return <img ref={ref} className={className} alt={alt} />;
}

/** The source image this output was made from, when the page still has it. */
export interface ImageComparison {
  readonly blob: Blob;
  /** The sniffed label of the source, e.g. "PNG image". */
  readonly label: string;
  readonly byteLength: number;
}

interface FigureProps {
  readonly blob: Blob;
  readonly caption: string;
  readonly facts: string;
  /** Named for the reader, not for the file: "Before" / "After". */
  readonly side: string | null;
}

function ImageFigure({ blob, caption, facts, side }: FigureProps) {
  return (
    <figure className={styles.figure}>
      <BlobImage blob={blob} alt={caption} className={styles.image} />
      <figcaption className={styles.caption}>
        {side === null ? null : <span className={styles.side}>{side}</span>}
        <span className={styles.facts}>{facts}</span>
      </figcaption>
    </figure>
  );
}

export interface ImageViewProps {
  readonly bytes: Bytes;
  readonly label: string;
  readonly filename: string;
  readonly comparison: ImageComparison | null;
  readonly onDownload: (blob: Blob, filename: string) => void;
}

export function ImageView({ bytes, label, filename, comparison, onDownload }: ImageViewProps) {
  const [view, setView] = useState<'result' | 'compare'>('result');
  const [confirmed, setConfirmed] = useState(false);

  const sniff = sniffBytes(bytes);
  const mediaType = sniff.mediaType ?? 'application/octet-stream';
  const oversized = bytes.byteLength > PREVIEW_LIMIT;
  const show = !oversized || confirmed;

  /*
   * Memoised so a re-render does not build a second Blob over the same bytes -
   * which would look like a new image to `BlobImage` and cost a fresh object
   * URL and a fresh decode. A discarded memo is correct, merely wasteful,
   * which is the right way round for a cache.
   */
  const blob = useMemo(() => new Blob([bytes], { type: mediaType }), [bytes, mediaType]);
  const facts = `${sniff.label} · ${formatBytes(bytes.byteLength)}`;

  return (
    <section className={styles.wrapper} aria-label={label}>
      {comparison === null ? null : (
        <ViewToggle
          label={label}
          value={view}
          onChange={setView}
          options={[
            { id: 'result', label: 'Result', status: 'Showing the converted image' },
            { id: 'compare', label: 'Compare', status: 'Showing the original beside the result' },
          ]}
        />
      )}

      {show ? (
        /*
         * ONE CONTAINER, AND KEYED FIGURES.
         *
         * The result figure keeps its identity across the toggle, so switching
         * to Compare adds the source beside it rather than tearing the result
         * down and building it again - which would revoke a perfectly good
         * object URL and pay for a second decode of an image already on
         * screen. The source figure is genuinely conditional, which is what
         * keeps its bitmap unpaid-for until somebody asks.
         */
        <div className={view === 'compare' && comparison !== null ? styles.compare : undefined}>
          {view === 'compare' && comparison !== null ? (
            <ImageFigure
              key="before"
              blob={comparison.blob}
              caption={`${label}, before conversion`}
              facts={`${comparison.label} · ${formatBytes(comparison.byteLength)}`}
              side="Before"
            />
          ) : null}
          <ImageFigure
            key="after"
            blob={blob}
            caption={view === 'compare' ? `${label}, after conversion` : label}
            facts={facts}
            side={view === 'compare' && comparison !== null ? 'After' : null}
          />
        </div>
      ) : (
        /*
         * Over the limit. The facts are still on screen - this is not a failure
         * and the size is what somebody converting a 40 MB PNG probably came
         * for - and the preview is one press away with its cost stated rather
         * than sprung on them.
         */
        <div className={styles.oversized}>
          <p className={styles.facts}>{facts}</p>
          <p className={styles.note}>
            Large enough that decoding it for a preview would cost more memory than the file itself.
            Download it, or show it here.
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirmed(true);
            }}
          >
            Show preview anyway
          </Button>
        </div>
      )}

      <div className={styles.actions}>
        {/*
          THE RAW PAYLOAD, ALWAYS ON SCREEN. See the note at the top: bytes
          have no textual form, so Download is the copy - and it is never
          behind a view switch.
        */}
        <Button
          size="sm"
          onClick={() => {
            onDownload(new Blob([bytes], { type: mediaType }), filename);
          }}
        >
          Download
        </Button>
        <span className={styles.hint}>{filename}</span>
      </div>
    </section>
  );
}
