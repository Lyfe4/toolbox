/**
 * HOW MUCH OF A TEXT RESULT IS PUT IN ITS BOX.
 *
 * A textarea is laid out whole, whatever part of it is scrolled into view, and
 * in both engines that is expensive at the sizes this app produces: measured in
 * round twenty-one with no app code at all, mounting a read-only textarea that
 * holds a 5.6 MB value takes about 575ms in Gecko and six seconds in WebKit.
 * The canvas mounts one after EVERY run - a running node says "Running" rather
 * than showing a stale answer - so typing into a four-megabyte field upstream
 * paid that once per keystroke, on the main thread, after the run landed.
 *
 * Capping what is shown removed all of it: 620ms of blocked main thread per
 * keystroke in Gecko and 1.3s in WebKit, to none. Nobody reads 5.6 MB in a
 * box a few hundred pixels tall; they copy it or download it, and both of those
 * still take the whole value - only the box is a preview, and it says so.
 *
 * 64 Ki characters is a screenful many times over and costs nothing measurable
 * to mount. It is a literal rather than an option because it is a statement
 * about textareas, not a preference anybody has.
 */
export const TEXT_PREVIEW_CHARS = 65_536;

export interface TextPreview {
  /** What goes in the box. */
  readonly shown: string;
  /** Whether that is less than the whole value. */
  readonly clipped: boolean;
}

export function textPreview(text: string): TextPreview {
  if (text.length <= TEXT_PREVIEW_CHARS) return { shown: text, clipped: false };

  // Never end on half of a surrogate pair: a lone high surrogate renders as a
  // replacement character, which would look like damage to the value itself.
  const code = text.charCodeAt(TEXT_PREVIEW_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? TEXT_PREVIEW_CHARS - 1 : TEXT_PREVIEW_CHARS;
  return { shown: text.slice(0, end), clipped: true };
}

/** The hint beside Copy and Download: a count, and whether the box has all of it. */
export function textPreviewHint(text: string, preview: TextPreview): string {
  const total = text.length.toLocaleString('en');
  if (!preview.clipped) return `${text.length.toString()} characters`;
  return `Showing the first ${preview.shown.length.toLocaleString('en')} of ${total} characters - Copy and Download take all of it`;
}
