import type { ReactElement } from "react";
import { Skeleton } from "./ui/skeleton";

/**
 * Full-viewport shell placeholder while config initializes or pulls first load.
 * Matches the real layout width (no max-width cap).
 */
export function AppShellSkeleton({
  showReviewsSidebar = false,
}: {
  showReviewsSidebar?: boolean;
}): ReactElement {
  return (
    <div className="flex h-screen w-full flex-col bg-gray-950">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-800 bg-gray-950 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="h-6 w-6 shrink-0 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex shrink-0 gap-1">
          <Skeleton className="h-7 w-7 rounded" />
          <Skeleton className="h-7 w-7 rounded" />
          <Skeleton className="h-7 w-7 rounded" />
          <Skeleton className="h-7 w-7 rounded" />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-gray-800 py-3 md:flex">
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-9 w-9 rounded-lg" />
          <Skeleton className="h-9 w-9 rounded-lg" />
        </div>
        {showReviewsSidebar ? (
          <>
            <div className="hidden w-72 shrink-0 space-y-2 border-r border-gray-800 p-3 md:block">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
            <div className="min-h-0 flex-1 space-y-3 p-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="min-h-[50%] w-full" />
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 p-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </div>
    </div>
  );
}
