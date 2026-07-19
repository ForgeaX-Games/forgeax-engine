// DropZone.tsx — full-window drag-drop overlay.
//
// The drop target is now the whole app (App.tsx owns the drag/drop handlers so a
// tape pair can be dropped anywhere), and import-by-click is a header button. This
// component is just the visual overlay shown while a drag is in progress; it frees
// the entire main area for the dock (no permanent dashed box).

/** Full-window overlay shown while a file drag is over the app. */
export function DropOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
      <div className="border-2 border-dashed border-brand rounded-xl px-12 py-10 text-center bg-card/60">
        <p className="text-sm font-medium text-foreground">Drop to load</p>
        <p className="text-xs text-muted-foreground mt-1">
          <code className="bg-muted px-1 rounded">frame-N.tape.bin</code> +{' '}
          <code className="bg-muted px-1 rounded">frame-N.report.json</code>
        </p>
      </div>
    </div>
  );
}
