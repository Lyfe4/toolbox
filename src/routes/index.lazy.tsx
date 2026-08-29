import { createLazyFileRoute } from '@tanstack/react-router';

import { TooltipProvider } from '@/components/Tooltip';
import { Canvas } from '@/features/canvas';

export function CanvasPage() {
  return (
    <TooltipProvider>
      <Canvas />
    </TooltipProvider>
  );
}

export const Route = createLazyFileRoute('/')({ component: CanvasPage });
