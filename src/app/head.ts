/**
 * Titles and meta tags, in one place.
 *
 * TanStack Router's `head` route option feeds `<HeadContent />` in the root
 * layout, and the deepest matched route wins for any given tag. So the root
 * declares the site-wide defaults once and each route overrides only the two
 * things that actually differ: its title and its description.
 *
 * `head` is a NON-lazy route option, so these live in `src/routes/*.tsx`
 * alongside the route declaration rather than in the `.lazy.tsx` component
 * files - the point of a title is that it is known before the chunk arrives.
 */

export const SITE_NAME = 'Patchbay';

export const SITE_DESCRIPTION =
  'A developer toolbox that runs entirely in your browser. Nothing you paste ever leaves the page.';

/** Absolute paths, because Open Graph consumers do not resolve relative ones. */
export const SOCIAL_IMAGE = '/social-preview.png';

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
}

/**
 * Builds the tags for one page.
 *
 * The title is `Page - Patchbay`, except on the home page where that would
 * read "Patchbay - Patchbay". An em dash rather than a bullet: it survives
 * being truncated in a narrow tab strip legibly.
 */
export function pageMeta({ page, description = SITE_DESCRIPTION }: PageMeta = {}): MetaTag[] {
  const title = page === undefined ? SITE_NAME : `${page} — ${SITE_NAME}`;

  return [
    { title },
    { name: 'description', content: description },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
  ];
}

/**
 * The tags that are the same on every page.
 *
 * Declared on the root route so they exist for a route that forgot, and so a
 * child route overriding `og:title` overrides only that one tag rather than
 * having to restate the whole set.
 */
export const SITE_META: MetaTag[] = [
  { property: 'og:site_name', content: SITE_NAME },
  { property: 'og:type', content: 'website' },
  { property: 'og:image', content: SOCIAL_IMAGE },
  { property: 'og:image:width', content: '1200' },
  { property: 'og:image:height', content: '630' },
  {
    property: 'og:image:alt',
    content: 'The Patchbay wordmark over a wired node graph, in the graphite theme.',
  },
  { name: 'twitter:card', content: 'summary_large_image' },
  { name: 'twitter:image', content: SOCIAL_IMAGE },
];
