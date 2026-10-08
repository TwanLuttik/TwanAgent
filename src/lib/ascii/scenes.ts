/*
 * Scene pieces from ascii.rest by @bas3line (https://github.com/bas3line), MIT.
 * Only the scenes category is bundled. Each module loads when it is selected.
 */
import type { Piece } from "./types.ts";

export const SCENES = [
  { id: "alpine-dawn", name: "Alpine dawn" },
  { id: "aurora-fjord", name: "Aurora fjord" },
  { id: "deep-reef", name: "Deep reef" },
  { id: "desert-night", name: "Desert night" },
  { id: "earthrise", name: "Earthrise" },
  { id: "kyoto-dusk", name: "Kyoto dusk" },
  { id: "marine-drive", name: "Marine drive" },
  { id: "misty-forest", name: "Misty forest" },
  { id: "night-coast", name: "Night coast" },
  { id: "ocean-sunset", name: "Ocean sunset" },
  { id: "storm-plains", name: "Storm plains" },
  { id: "taj-dawn", name: "Taj dawn" },
  { id: "varanasi-ghats", name: "Varanasi ghats" },
] as const;

export type SceneId = (typeof SCENES)[number]["id"];

export const DEFAULT_SCENE: SceneId = "night-coast";

const LOADERS: Record<SceneId, () => Promise<Piece>> = {
  "alpine-dawn": () => import("./pieces/alpine-dawn.ts"),
  "aurora-fjord": () => import("./pieces/aurora-fjord.ts"),
  "deep-reef": () => import("./pieces/deep-reef.ts"),
  "desert-night": () => import("./pieces/desert-night.ts"),
  "earthrise": () => import("./pieces/earthrise.ts"),
  "kyoto-dusk": () => import("./pieces/kyoto-dusk.ts"),
  "marine-drive": () => import("./pieces/marine-drive.ts"),
  "misty-forest": () => import("./pieces/misty-forest.ts"),
  "night-coast": () => import("./pieces/night-coast.ts"),
  "ocean-sunset": () => import("./pieces/ocean-sunset.ts"),
  "storm-plains": () => import("./pieces/storm-plains.ts"),
  "taj-dawn": () => import("./pieces/taj-dawn.ts"),
  "varanasi-ghats": () => import("./pieces/varanasi-ghats.ts"),
};

export function isSceneId(value: string): value is SceneId {
  return Object.prototype.hasOwnProperty.call(LOADERS, value);
}

export function loadScene(id: SceneId): Promise<Piece> {
  return LOADERS[id]();
}
