import { useEffect, useRef, useState } from "react";
import spaceCorner from "../assets/space-corner.jpg";
import { mount } from "../lib/ascii/mount";
import { isSceneId, loadScene, type SceneId } from "../lib/ascii/scenes";
import { loadSpaceCornerScene, subscribePrefs } from "../lib/prefs";

const SPACE_FADE =
  "radial-gradient(ellipse 120% 115% at 0% 0%, #000 0%, #000 16%, transparent 70%)";

/** Pixel width. The scene player sets the canvas to 100% of its box, so a percent here would follow the sidebar. */
const SCENE_WIDTH = 500;

export function SpaceCorner() {
  const [scene, setScene] = useState(() => loadSpaceCornerScene());
  useEffect(() => subscribePrefs(() => setScene(loadSpaceCornerScene())), []);
  const video = isSceneId(scene);

  return (
    <div className="sidebar-space" aria-hidden>
      {video ? (
        <SceneCanvas id={scene} />
      ) : (
        <div
          className="sidebar-space-art"
          style={{
            backgroundImage: `url(${spaceCorner})`,
            WebkitMaskImage: SPACE_FADE,
            maskImage: SPACE_FADE,
          }}
        />
      )}
      <div
        className="sidebar-space-dots"
        style={{ WebkitMaskImage: SPACE_FADE, maskImage: SPACE_FADE }}
      />
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
