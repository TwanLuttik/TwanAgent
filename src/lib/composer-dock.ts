export type ComposerDockPlace = {
  top: string;
  bottom: string;
  /** null keeps transform off. A translate would leave the box below the clip. */
  y: string | null;
};

/**
 * Where the composer sits.
 * Centered and sliding still use a translate. Once it is docked, the border
 * box has to stay inside the clipped column. `top: 100%` plus `translateY(-100%)`
 * paints it at the bottom but lays it out underneath, and Enter then scrolls
 * that clip to chase the caret — the chat jumps up.
 */
export function composerDockPlace(centered: boolean, sliding: boolean): ComposerDockPlace {
  if (centered) return { top: "42%", bottom: "auto", y: "-50%" };
  if (sliding) return { top: "100%", bottom: "auto", y: "-100%" };
  return { top: "auto", bottom: "0", y: null };
}
