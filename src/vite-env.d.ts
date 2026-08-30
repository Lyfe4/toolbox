/// <reference types="vite/client" />

/**
 * The project's own environment variables.
 *
 * `vite/client` types `import.meta.env` generically; this narrows the one
 * variable we actually define, so a typo in the name is a compile error rather
 * than `undefined` finding its way into an og:url.
 */
interface ImportMetaEnv {
  /** The site's public origin, no trailing slash. See `.env`. */
  readonly VITE_SITE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
