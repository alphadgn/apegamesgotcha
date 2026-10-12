/**
 * Shown while a page is getting ready (signed-in pages, slow loads). It waits a moment before appearing, so a
 * quick page change never flashes it, and keeps the page's height so the footer doesn't jump.
 */
export function PagePending() {
  return (
    <div className="page-pending flex min-h-[60vh] flex-1 items-center justify-center" role="status" aria-live="polite">
      <span className="page-pending-dot" aria-hidden />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
