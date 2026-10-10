/** Keep a fixed menu inside the viewport. Prefer opening down-right from the cursor. */

export function placeMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  bounds: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  const maxLeft = Math.max(margin, bounds.width - margin - width);
  const maxTop = Math.max(margin, bounds.height - margin - height);
  let left = x;
  let top = y;
  if (left + width > bounds.width - margin) left = x - width;
  if (top + height > bounds.height - margin) top = y - height;
  return {
    left: Math.min(Math.max(margin, left), maxLeft),
    top: Math.min(Math.max(margin, top), maxTop),
  };
}
