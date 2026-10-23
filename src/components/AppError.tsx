import { Button } from "./Button";

/**
 * Shown when React throws while a screen is painting.
 * The conversation itself keeps running in the app process. Reloading only
 * replaces this window, then the open chat rejoins that turn.
 */
export function AppError({ onReload }: { onReload: () => void }) {
  return (
    <div className="flex h-full items-center justify-center bg-sidebar px-6 text-ink">
      <div className="w-full max-w-sm rounded-lg border border-line bg-canvas px-5 py-4 shadow-card">
        <p className="text-[15px] font-medium">Something went wrong in the app</p>
        <p className="mt-1.5 text-[13px] leading-5 text-muted">
          A running conversation keeps going. Reload to open it again.
        </p>
        <div className="mt-4">
          <Button variant="primary" onClick={onReload}>
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
