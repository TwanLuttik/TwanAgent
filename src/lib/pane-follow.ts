import { filePaneNeedsReload } from "./pane-sessions.ts";

/**
 * A different project waits until the open conversation can take a click.
 * Another spelling of the same folder still follows immediately, or the
 * loading cover stays up on a path that only changed case.
 */
export function paneProjectFollow(shown: string, next: string): "now" | "later" {
  if (!next || !filePaneNeedsReload(shown, next)) return "now";
  return "later";
}

/** Keep the file highlight on the project still mounted while another one opens. */
export function holdPaneSelection(switching: boolean, held: string | null, live: string | null): string | null {
  return switching ? held : live;
}
