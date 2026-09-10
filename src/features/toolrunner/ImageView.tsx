import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import type { Bytes } from '@/features/registry/types';
import { formatBytes, sniffBytes } from '@/lib/sniff';
import { inspectImage } from '@/tools/image-convert/inspect';
import type { DecodableType } from '@/tools/image-convert/inspect';

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

/**
 * Media types this view is willing to hand to an `<img>`.
 *
 * Held to `DecodableType` by `satisfies` rather than merely written to match
 * it: this list and the image tool's header reader have to agree about which
 * formats exist, and a format added to one and not the other should be a
 * compile error rather than a preview that silently loses its reserved box.
 */
const PREVIEWABLE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const satisfies readonly DecodableType[];

/** The sniffed type, when this view can draw it. Narrows; a Set cannot. */
function previewableType(bytes: Bytes): DecodableType | null {
  const { mediaType } = sniffBytes(bytes);
  return PREVIEWABLE_TYPES.find((type) => type === mediaType) ?? null;
}

export function isPreviewableImage(bytes: Bytes): boolean {
  return previewableType(bytes) !== null;
}

/**
 * THE SHAPE OF THE PICTURE, KNOWN BEFORE IT IS DECODED.
 *
 * An `<img>` whose `src` has not finished loading has no intrinsic size, and
 * this one is laid out `inline-size: 100%` with its height left to the
 * picture - so it occupies ZERO height until the decode lands and then jumps
 * to as much as 420px, on the frame after a run finishes. Everything below the
 * preview moves under the cursor at the exact moment somebody is reaching for
 * it. That was a real defect rather than a cosmetic one, and it survived for
 * as long as it did because the CSS written to prevent it - a `.placeholder`
 * block holding the panel open - was never named by any component, so it had
 * never once been on an element. `cssModules.test.ts` asks the reverse
 * question now and that is what turned it up.
 *
 * A reserved box of a FIXED height only moves the jump: a favicon would open a
 * 420px hole and then collapse it. The box has to be the right size from the
 * first frame, which means knowing the aspect ratio before the decode - and
 * every format this view will preview states its own dimensions in its header,
 * within the first few dozen bytes.
 *
 * `inspectImage` is the image tool's existing header reader, reused rather
 * than reimplemented. It walks a bounded chunk or marker table, decompresses
 * nothing, and returns nulls for anything it could not read - so a truncated
 * or unusual file degrades to today's behaviour instead of failing.
 */
export function previewAspectRatio(bytes: Bytes): number | null {
  const mediaType = previewableType(bytes);
  if (mediaType === null) return null;

  const { width, height } = inspectImage(bytes, mediaType);
  if (width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;

  return width / height;
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
  ratio,
}: {
  readonly blob: Blob;
  readonly alt: string;
  readonly className: string | undefined;
  /** Width over height, from the file's own header. See previewAspectRatio. */
  readonly ratio: number | null;
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

  /*
   * The ratio is an INLINE STYLE rather than a class, because it is a
   * measurement of this particular file and not a design decision - there is
   * no set of ratios a stylesheet could enumerate. `undefined` when the header
   * could not be read, which leaves the element exactly as it was before this
   * existed: correct once loaded, and jumping to get there.
   */
  return (
    <img
      ref={ref}
      className={className}
      alt={alt}
      style={ratio === null ? undefined : { aspectRatio: ratio }}
    />
  );
}

/** The source image this output was made from, when the page still has it. */
export interface ImageComparison {
  readonly blob: Blob;
  /** The sniffed label of the source, e.g. "PNG image". */
  readonly label: string;
  readonly byteLength: number;
  /**
   * Width over height, when the source's header could be read.
   *
   * Carried on the comparison rather than derived here, because this side is
   * a `Blob` and not bytes: the File the browser is already holding is handed
   * over as-is, precisely so that showing a thumbnail of a 40 MB photograph
   * does not copy 40 MB into React state. Whoever DID have the bytes measures
   * them; see `comparisonFor`.
   */
  readonly ratio: number | null;
}

interface FigureProps {
  readonly blob: Blob;
  readonly caption: string;
  readonly facts: string;
  /** Named for the reader, not for the file: "Before" / "After". */
  readonly side: string | null;
  readonly ratio: number | null;
}

function ImageFigure({ blob, caption, facts, side, ratio }: FigureProps) {
  return (
    <figure className={styles.figure}>
      <BlobImage blob={blob} alt={caption} className={styles.image} ratio={ratio} />
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

  /*
   * Memoised for the same reason as the Blob: a header walk per render would
   * be pure waste, and the answer cannot change while the bytes do not.
   *
   * And skipped entirely while the preview is behind the size confirmation.
   * There is no box to reserve until somebody asks for one, and the file that
   * put them behind that button is the largest file this view ever sees -
   * exactly the one whose header is least worth walking for nothing. Pressing
   * the button recomputes it in the same render that mounts the image, so the
   * box is still right on its first frame.
   */
  const ratio = useMemo(() => (show ? previewAspectRatio(bytes) : null), [bytes, show]);

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
              ratio={comparison.ratio}
            />
          ) : null}
          <ImageFigure
            key="after"
            blob={blob}
            caption={view === 'compare' ? `${label}, after conversion` : label}
            facts={facts}
            side={view === 'compare' && comparison !== null ? 'After' : null}
            ratio={ratio}
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
