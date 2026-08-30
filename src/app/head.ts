/**
 * Titles and meta tags.
 *
 * THERE ARE TWO SETS, AND THEY ARE FOR DIFFERENT AUDIENCES.
 *
 * 1. A complete STATIC baseline in index.html, every tag marked `data-default`.
 *    This is what a crawler or a link-preview bot sees, and it is the only set
 *    any of them will ever see, because none of them run JavaScript. Sharing a
 *    URL anywhere - Slack, a chat app, a search result - is answered entirely
 *    by that markup.
 *
 * 2. This module, applied at runtime by TanStack Router's `head` route option
 *    feeding `<HeadContent />` in the root layout. This is what makes the tab
 *    strip say "Base64 - Patchbay" instead of "Patchbay" on every route.
 *
 * WHY THE STATIC ONES ARE REMOVED
 *
 * React hoists the tags this module produces into <head>, but it does not
 * remove anything that was already there. Measured before this existed: every
 * route ended up with two <title> elements, two og:title, two og:description,
 * two description and two og:image - the static value and the route's value,
 * side by side, with no defined winner for a consumer reading the document.
 *
 * So `dropStaticHead` below removes the `data-default` set once the router's
 * head is live. The division of labour is exact: the static tags exist for
 * consumers that never execute this file, and the moment this file executes,
 * they have been superseded.
 *
 * WHY THE URLS ARE ABSOLUTE
 *
 * `og:image` was `/social-preview.png`. The Open Graph specification requires
 * an absolute URL; most consumers resolve a root-relative one against the page
 * anyway, but "most" is not a guarantee worth taking on the one tag whose
 * failure mode is a shared link with a blank card. VITE_SITE_URL supplies the
 * origin - see `.env` - and the build refuses to finish if it did not
 * substitute.
 */

/** No trailing slash. Substituted by Vite; see `.env` and `vite/plugins/index-html.ts`. */
export const SITE_URL = import.meta.env.VITE_SITE_URL;

export const SITE_NAME = 'Patchbay';

export const SITE_DESCRIPTION =
  'A developer toolbox that runs entirely in your browser. Nothing you paste ever leaves the page.';

export const SOCIAL_IMAGE = `${SITE_URL}/social-preview.png`;

export const SOCIAL_IMAGE_ALT =
  'The Patchbay wordmark over a wired node graph, in the graphite theme.';

/**
 * One meta tag, in the shape `head` wants.
 *
 * The router's own type for a meta entry is a loose record, so this narrow
 * alias is what keeps the call sites honest: a tag is either a title, or a
 * `name`/`content` pair, or a `property`/`content` pair, and nothing else.
 */
export type MetaTag =
  | { readonly title: string }
  | { readonly name: string; readonly content: string }
  | { readonly property: string; readonly content: string };

export interface PageMeta {
  /** The page's own name. "Tools", "Styleguide", "Base64". */
  readonly page?: string;
  readonly description?: string;
  /** This route's path, leading slash, no origin. Used for og:url and canonical. */
  readonly path: string;
}

/**
 * Everything one route contributes to the head.
 *
 * Returns `links` as well as `meta`, because a canonical URL is a <link>.
 * Only LEAF routes may call this: `HeadContent` de-duplicates meta by
 * name/property with the deepest match winning, but it concatenates links, so
 * a canonical declared on the root route as well would give every page two.
 */
export function pageHead({ page, description = SITE_DESCRIPTION, path }: PageMeta): {
  meta: MetaTag[];
  links: { rel: string; href: string }[];
} {
  // "Patchbay" on the home page rather than "Patchbay — Patchbay". An em dash
  // because it survives truncation in a narrow tab strip legibly.
  const title = page === undefined ? SITE_NAME : `${page} — ${SITE_NAME}`;
  const url = `${SITE_URL}${path}`;

  return {
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: description },
    ],
    links: [{ rel: 'canonical', href: url }],
  };
}

/**
 * The tags that are the same on every page.
 *
 * Declared on the root route so they exist for a route that forgot, and so a
 * child overriding `og:title` overrides only that one tag rather than having
 * to restate the whole set. No canonical here - see `pageHead`.
 */
export const SITE_META: MetaTag[] = [
  { property: 'og:site_name', content: SITE_NAME },
  { property: 'og:type', content: 'website' },
  { property: 'og:locale', content: 'en' },
  { property: 'og:image', content: SOCIAL_IMAGE },
  { property: 'og:image:width', content: '1200' },
  { property: 'og:image:height', content: '630' },
  { property: 'og:image:alt', content: SOCIAL_IMAGE_ALT },
  { name: 'twitter:card', content: 'summary_large_image' },
  { name: 'twitter:image', content: SOCIAL_IMAGE },
];

/**
 * Removes the static baseline from <head>.
 *
 * Called once, from an effect in the root layout - by which point
 * `<HeadContent />` has committed its own tags, so there is never a moment
 * with neither. Idempotent, and harmless if index.html ever stops carrying
 * them.
 */
export function dropStaticHead(): void {
  for (const node of document.head.querySelectorAll('[data-default]')) {
    node.remove();
  }
}
