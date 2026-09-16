import spaceCorner from "../assets/space-corner.jpg";

const SPACE_FADE =
  "radial-gradient(ellipse 120% 115% at 0% 0%, #000 0%, #000 16%, transparent 70%)";

export function SpaceCorner() {
  return (
    <div className="sidebar-space" aria-hidden>
      <div
        className="sidebar-space-art"
        style={{
          backgroundImage: `url(${spaceCorner})`,
          WebkitMaskImage: SPACE_FADE,
          maskImage: SPACE_FADE,
        }}
      />
      <div
        className="sidebar-space-dots"
        style={{ WebkitMaskImage: SPACE_FADE, maskImage: SPACE_FADE }}
      />
    </div>
  );
}
