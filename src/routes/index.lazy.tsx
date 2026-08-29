import { createLazyFileRoute, useSearch } from '@tanstack/react-router';

import { TooltipProvider } from '@/components/Tooltip';
import { Canvas } from '@/features/canvas';

export function CanvasPage() {
  // Typed by the route's Zod search schema in index.tsx.
  const { p } = useSearch({ from: '/' });

  return (
    <TooltipProvider>
      <Canvas shareParam={p} />
    </TooltipProvider>
  );
}

export const Route = createLazyFileRoute('/')({ component: CanvasPage });
