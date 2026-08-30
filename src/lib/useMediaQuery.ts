import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a media query.
 *
 * `useSyncExternalStore` rather than an effect and a state: it is the hook
 * built for exactly this - an external source of truth React does not own -
 * and it reads the current value during render rather than one paint later, so
 * a narrow viewport never gets one frame of the wide layout first.
 *
 * The server snapshot returns false because there is no server here; it exists
 * so the hook is safe if the app is ever prerendered, where "no match" is the
 * only honest answer.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => subscribe(query, onChange),
    () => matches(query),
    () => false,
  );
}

function supported(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function matches(query: string): boolean {
  return supported() && window.matchMedia(query).matches;
}

function subscribe(query: string, onChange: () => void): () => void {
  if (!supported()) return () => undefined;

  const list = window.matchMedia(query);
  list.addEventListener('change', onChange);
  return () => {
    list.removeEventListener('change', onChange);
  };
}
