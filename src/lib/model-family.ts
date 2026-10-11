export type ModelFamilyInput = {
  id: string;
  name: string;
};

export type ModelFamily<T extends ModelFamilyInput> = {
  key: string;
  label: string;
  models: T[];
};

/**
 * "Claude Opus 4.8" and "Claude Opus 4.7" share a family. One model stays alone.
 * The version is the trailing number, so "Claude 3 Haiku" is its own name.
 */
export function modelFamilyName(name: string): { family: string; version: string } {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*?)(?:\s+)(\d+(?:\.\d+)*)$/);
  const family = (match?.[1] ?? trimmed).trim();
  return { family: family || trimmed, version: match?.[2] ?? "" };
}

/** Capabilities every member shares. Null when the family has one model or the sets differ. */
export function sharedModelCapabilities<T extends { capabilities?: readonly string[] | null }>(
  models: readonly T[],
): string[] | null {
  if (models.length < 2) return null;
  const key = (ids?: readonly string[] | null) => [...(ids ?? [])].sort().join("\0");
  const first = key(models[0]?.capabilities);
  if (!first || !models.every((row) => key(row.capabilities) === first)) return null;
  return [...(models[0].capabilities ?? [])];
}

export function groupModelFamilies<T extends ModelFamilyInput>(models: readonly T[]): ModelFamily<T>[] {
  const groups: ModelFamily<T>[] = [];
  for (const model of models) {
    const { family } = modelFamilyName(model.name);
    const key = family.toLowerCase();
    const existing = groups.find((group) => group.key === key);
    if (existing) existing.models.push(model);
    else groups.push({ key, label: family, models: [model] });
  }
  return groups;
}
