export function textareaFitHeight(input: {
  value: string;
  scrollHeight: number;
  lineHeight: number;
  paddingY: number;
  max: number;
}): number {
  const empty = input.lineHeight + input.paddingY;
  const raw = input.value === "" ? empty : Math.max(empty, input.scrollHeight);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, input.max);
}
