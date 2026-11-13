export type OpenAiSpeed = {
  id: string;
  label: string;
  detail: string;
};

/** Composer speeds. The API name for Standard is `default`. */
export const OPENAI_SPEEDS: readonly OpenAiSpeed[] = [
  { id: "standard", label: "Standard", detail: "Normal speed and price." },
  { id: "flex", label: "Flex", detail: "Slower replies, about half the price." },
  { id: "fast", label: "Fast", detail: "Quicker replies, higher price." },
  { id: "ultrafast", label: "Ultrafast", detail: "Fastest. Astra and Sol only." },
];

/** Ultrafast is only offered on Astra and Sol. */
export function openaiSpeedsFor(modelId: string): OpenAiSpeed[] {
  const ultra = modelId.trim() === "gpt-6-astra" || modelId.trim() === "gpt-6.1-sol";
  return OPENAI_SPEEDS.filter((row) => ultra || row.id !== "ultrafast");
}

/** A saved speed this model cannot use falls back to Standard. */
export function openaiSpeedChoice(modelId: string, saved: string): string {
  const id = saved.trim();
  return openaiSpeedsFor(modelId).some((row) => row.id === id) ? id : "standard";
}

export function openaiSpeedLabel(id: string): string {
  return OPENAI_SPEEDS.find((row) => row.id === id)?.label ?? "Standard";
}
