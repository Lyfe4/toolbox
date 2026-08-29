import styles from './SkipLink.module.css';

export interface SkipLinkProps {
  /** id of the element to jump to, without the leading '#'. */
  readonly targetId: string;
  readonly children?: string;
}

/**
 * First tab stop on every page. Lets keyboard and screen-reader users jump
 * past the chrome straight into the content.
 */
export function SkipLink({ targetId, children = 'Skip to content' }: SkipLinkProps) {
  return (
    <a className={styles.root} href={`#${targetId}`}>
      {children}
    </a>
  );
}
