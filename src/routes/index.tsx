import { createFileRoute } from '@tanstack/react-router';

/**
 * Route declaration only. The canvas lives in index.lazy.tsx, so its code -
 * and Radix's tooltip machinery with it - is fetched on first navigation
 * rather than shipped to everyone who only ever opens /tools.
 */
export const Route = createFileRoute('/')({});
