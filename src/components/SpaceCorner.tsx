import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import spaceCorner from "../assets/space-corner.jpg";
import { mount } from "../lib/ascii/mount";
import { isSceneId, loadScene, type SceneId } from "../lib/ascii/scenes";
import {
  loadSpaceCornerImage,
  loadSpaceCornerScene,
  setSpaceCornerImage,
  subscribePrefs,
  type SpaceCornerImage,
} from "../lib/prefs";

/* Solid only in the window corner. It has to be gone before the main
   container's top-left stroke, or that curve disappears into the picture. */
const SPACE_FADE =
  "radial-gradient(ellipse 95% 90% at 0% 0%, #000 0%, #000 4%, transparent 32%)";

/** Pixel width. The scene player sets the canvas to 100% of its box, so a percent here would follow the sidebar. */
const SCENE_WIDTH = 500;
/** Longest edge of a custom picture. The other edge follows the image so it is not stretched. */
const ART_MAX = 360;

function artSize(width: number, height: number): { width: number; height: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = ART_MAX / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function SpaceCorner() {
  const [scene, setScene] = useState(() => loadSpaceCornerScene());
  const [image, setImage] = useState(() => loadSpaceCornerImage());
  useEffect(
    () =>
      subscribePrefs(() => {
        setScene(loadSpaceCornerScene());
        setImage(loadSpaceCornerImage());
      }),
    [],
  );
  const video = isSceneId(scene);
  const custom = image ? convertFileSrc(image.path) : "";
  const fitted = image ? artSize(image.width, image.height) : null;

  return (
    <div className="sidebar-space" aria-hidden>
      {video ? (
        <SceneCanvas id={scene} />
      ) : (
        <CornerArt src={custom || spaceCorner} image={image} fitted={fitted} />
      )}
      <div
        className="sidebar-space-dots"
        style={{ WebkitMaskImage: SPACE_FADE, maskImage: SPACE_FADE }}
      />
    </div>
  );
}

function CornerArt({
  src,
  image,
  fitted,
}: {
  src: string;
  image: SpaceCornerImage | null;
  fitted: { width: number; height: number } | null;
}) {
  return (
    <div
      className="sidebar-space-art"
      style={{
        backgroundImage: `url(${src})`,
        WebkitMaskImage: SPACE_FADE,
        maskImage: SPACE_FADE,
        ...(fitted ? { width: fitted.width, height: fitted.height, backgroundSize: "100% 100%" } : null),
      }}
    >
      {image && !fitted ? (
        <img
          src={src}
          alt=""
          className="pointer-events-none absolute size-0 opacity-0"
          onLoad={(ev) => {
            const { naturalWidth, naturalHeight } = ev.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              setSpaceCornerImage({ ...image, width: naturalWidth, height: naturalHeight });
            }
          }}
        />
      ) : null}
    </div>
  );
}

function SceneCanvas({ id }: { id: SceneId }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let stop: () => void = () => undefined;
    let gone = false;
    void loadScene(id).then((piece) => {
      if (gone || !ref.current) return;
      stop = mount(ref.current, piece, { fps: 12, motion: true });
    });
    return () => {
      gone = true;
      stop();
    };
  }, [id]);

  return (
    <canvas
      ref={ref}
      className="sidebar-space-scene"
      style={{ width: SCENE_WIDTH, WebkitMaskImage: SPACE_FADE, maskImage: SPACE_FADE }}
    />
  );
}
