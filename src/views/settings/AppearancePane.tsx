import { useState } from "react";
import { Button } from "../../components/Button";
import { ThemePicker } from "../../components/ThemePicker";
import { DEFAULT_SCENE, isSceneId, SCENES, type SceneId } from "../../lib/ascii/scenes";
import {
  loadExpandEdits,
  loadFileHoverCard,
  loadLiveSocketDebug,
  loadMarkdownOpenMode,
  loadPerfOverlay,
  loadSidebarAccountUsage,
  loadSpaceCorner,
  loadSpaceCornerImage,
  loadSpaceCornerScene,
  loadWrapLines,
  saveMarkdownOpenMode,
  saveSidebarAccountUsage,
  setExpandEdits,
  setFileHoverCard,
  setLiveSocketDebug,
  setPerfOverlay,
  setSpaceCorner,
  setSpaceCornerImage,
  setSpaceCornerScene,
  setWrapLines,
  type MarkdownOpenMode,
  type SidebarAccountUsageMode,
  type SpaceCornerImage,
} from "../../lib/prefs";
import { loadTheme, type ThemeSelection } from "../../lib/theme";
import * as api from "../../lib/tauri";
import { useApp } from "../../state/app-state";
import { Block, Choice, fieldClass, Group, Page, Toggle } from "./SettingsChrome";

export function AppearancePane() {
  const { setFlash } = useApp();
  const [theme, setThemeSel] = useState<ThemeSelection>(() => loadTheme());
  const [spaceArt, setSpaceArt] = useState(() => loadSpaceCorner());
  const [spaceScene, setSpaceScene] = useState<SceneId>(() => {
    const stored = loadSpaceCornerScene();
    return isSceneId(stored) ? stored : DEFAULT_SCENE;
  });
  const [spaceVideo, setSpaceVideo] = useState(() => isSceneId(loadSpaceCornerScene()));
  const [spaceImage, setSpaceImage] = useState<SpaceCornerImage | null>(() => loadSpaceCornerImage());
  const [pickingImage, setPickingImage] = useState(false);
  const [fileHoverCard, setFileHoverCardOn] = useState(() => loadFileHoverCard());
  const [perfOverlay, setPerfOverlayOn] = useState(() => loadPerfOverlay());
  const [liveSocketDebug, setLiveSocketDebugOn] = useState(() => loadLiveSocketDebug());
  const [expandEdits, setExpandEditsOn] = useState(() => loadExpandEdits());
  const [wrapLines, setWrapLinesOn] = useState(() => loadWrapLines());
  const [markdownOpen, setMarkdownOpen] = useState<MarkdownOpenMode>(() => loadMarkdownOpenMode());
  const [accountUsage, setAccountUsage] = useState<SidebarAccountUsageMode>(() => loadSidebarAccountUsage());

  return (
    <Page title="Appearance" text="Theme, the sidebar, and how chats and files open.">
      <Group title="Theme">
        <Block>
          <ThemePicker value={theme} onChange={setThemeSel} />
        </Block>
      </Group>

      <Group title="Sidebar" text="What sits in the sidebar besides the project list.">
        <Choice
          title="Account usage"
          text="Plans and rate limits under Usage. Minimized is one line per account."
          value={accountUsage}
          options={[
            { id: "full", label: "Full" },
            { id: "minimized", label: "Minimized" },
            { id: "off", label: "Off" },
          ] as const}
          onChange={(next) => {
            setAccountUsage(next);
            saveSidebarAccountUsage(next);
          }}
        />
        <Toggle
          title="Space corner"
          text="Show a faded picture in the top-left."
          checked={spaceArt}
          onChange={(next) => {
            setSpaceArt(next);
            setSpaceCorner(next);
          }}
        />
        <Block>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">Picture</div>
              <div className="mt-0.5 text-[12px] leading-snug text-muted">
                {spaceImage
                  ? `${spaceImage.name} is saved with the app, so it stays if you delete the original.`
                  : "Uses the built-in picture. A chosen image is copied into the app folder."}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                size="sm"
                disabled={pickingImage}
                onClick={() => {
                  setPickingImage(true);
                  void api
                    .pickImage()
                    .then(async (path) => {
                      if (!path) return;
                      const saved = await api.setSpaceCornerImage(path);
                      const next = {
                        path: saved.path,
                        name: saved.name,
                        width: saved.width,
                        height: saved.height,
                      };
                      setSpaceImage(next);
                      setSpaceCornerImage(next);
                      if (!spaceArt) {
                        setSpaceArt(true);
                        setSpaceCorner(true);
                      }
                      if (spaceVideo) {
                        setSpaceVideo(false);
                        setSpaceCornerScene("");
                      }
                      setFlash({ kind: "ok", text: `Using ${saved.name} in the corner.` });
                    })
                    .catch((e) => setFlash({ kind: "err", text: String(e) }))
                    .finally(() => setPickingImage(false));
                }}
              >
                {pickingImage ? "Choosing…" : spaceImage ? "Change" : "Choose"}
              </Button>
              {spaceImage ? (
                <Button
                  size="sm"
                  onClick={() => {
                    void api
                      .clearSpaceCornerImage()
                      .then(() => {
                        setSpaceImage(null);
                        setSpaceCornerImage(null);
                        setFlash({ kind: "ok", text: "Using the built-in picture." });
                      })
                      .catch((e) => setFlash({ kind: "err", text: String(e) }));
                  }}
                >
                  Default
                </Button>
              ) : null}
            </div>
          </div>
        </Block>
        <Toggle
          title="Video"
          text="Play an animated ascii scene instead of the picture."
          checked={spaceVideo}
          onChange={(next) => {
            setSpaceVideo(next);
            setSpaceCornerScene(next ? spaceScene : "");
            if (next && !spaceArt) {
              setSpaceArt(true);
              setSpaceCorner(true);
            }
          }}
        />
        {spaceVideo ? (
          <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
            <span className="text-[13px] font-medium text-ink">Scene</span>
            <select
              value={spaceScene}
              onChange={(e) => {
                const next = e.target.value;
                if (!isSceneId(next)) return;
                setSpaceScene(next);
                setSpaceCornerScene(next);
              }}
              className={`${fieldClass} max-w-[12rem]`}
            >
              {SCENES.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {scene.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </Group>

      <Group title="Chat">
        <Toggle
          title="File hover cards"
          text="Show a small preview when you hover a file name."
          checked={fileHoverCard}
          onChange={(next) => {
            setFileHoverCardOn(next);
            setFileHoverCard(next);
          }}
        />
        <Toggle
          title="Expand edits"
          text="Open file edit diffs. Reads, lists, and commands stay collapsed."
          checked={expandEdits}
          onChange={(next) => {
            setExpandEditsOn(next);
            setExpandEdits(next);
          }}
        />
        <Choice
          title="Open Markdown in"
          text="You can still switch on the file tab."
          value={markdownOpen}
          options={[
            { id: "editor", label: "Editor" },
            { id: "viewer", label: "Viewer" },
          ] as const}
          onChange={(next) => {
            setMarkdownOpen(next);
            saveMarkdownOpenMode(next);
          }}
        />
      </Group>

      <Group title="Editor">
        <Toggle
          title="Wrap lines"
          text="Break long lines so you don't have to scroll sideways."
          checked={wrapLines}
          onChange={(next) => {
            setWrapLinesOn(next);
            setWrapLines(next);
          }}
        />
      </Group>

      <Group title="Developer" text="Overlays for checking the app. Off unless you are debugging.">
        <Toggle
          title="Performance overlay"
          text="FPS, native CPU, and memory in the bottom-right."
          checked={perfOverlay}
          onChange={(next) => {
            setPerfOverlayOn(next);
            setPerfOverlay(next);
          }}
        />
        <Toggle
          title="Live socket debug"
          text="Raw websocket frames from a cloud conversation."
          checked={liveSocketDebug}
          onChange={(next) => {
            setLiveSocketDebugOn(next);
            setLiveSocketDebug(next);
          }}
        />
      </Group>
    </Page>
  );
}
