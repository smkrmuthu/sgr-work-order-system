'use client';

// Shown instead of a blank page when a screen hits an unexpected error. The data is never lost by this: everything
// already saved is in the database; only what was being typed on this screen is.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-lg border border-rose-200 bg-white p-6 text-center shadow-sm">
      <div className="mb-2 text-sm font-bold text-rose-800">Something went wrong on this screen</div>
      <p className="mb-4 text-xs text-ink-500">Anything already saved is safe. Try again; if it keeps happening, tell the person who looks after this system what you were doing.</p>
      <p className="mb-4 break-words font-mono text-[10px] text-ink-500">{error.message}</p>
      <div className="flex justify-center gap-2">
        <button onClick={reset} className="btn-secondary">Try again</button>
        <button onClick={() => window.location.reload()} className="btn-secondary">Reload page</button>
      </div>
    </div>
  );
}
