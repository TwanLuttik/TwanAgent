import { skillPillSummary, type DetectedSkill } from "../lib/skill";
import { Button } from "./Button";
import { DockShell } from "./DockShell";

const ORIGIN_LABEL: Record<DetectedSkill["origin"], string> = {
  project: "Project",
  user: "User",
  plugin: "Plugin",
  bundled: "Bundled",
  claude: "Claude",
  cursor: "Cursor",
};

export function SkillDock({
  skills,
  busyName,
  onToggle,
  onEdit,
}: {
  skills: DetectedSkill[];
  busyName?: string | null;
  onToggle: (skill: DetectedSkill, enabled: boolean) => void;
  onEdit: (skill: DetectedSkill) => void;
}) {
  if (skills.length === 0) return null;
  const onCount = skills.filter((row) => row.enabled).length;
  return (
    <DockShell
      icon="doc"
      summary={skillPillSummary(skills)}
      meta={`${onCount}/${skills.length} on`}
      hint="Toggle what Grok can use. Edit opens SKILL.md here. TwanAgent does not auto-run these."
    >
      <div className="space-y-1">
        {skills.map((skill) => {
          const busy = busyName === skill.name;
          return (
            <div key={skill.source} className="flex items-center gap-2.5 rounded-xl px-1.5 py-1.5 hover:bg-wash">
              <EnableSwitch
                on={skill.enabled}
                disabled={busy}
                label={`Enable ${skill.name}`}
                onClick={() => onToggle(skill, !skill.enabled)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-5 font-medium text-ink">{skill.name}</div>
                <div className="truncate text-[11px] leading-4 whitespace-nowrap text-muted/75">
                  {ORIGIN_LABEL[skill.origin]}
                  {skill.description ? ` · ${skill.description}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" disabled={busy} onClick={() => onEdit(skill)} title="Edit SKILL.md">
                  Edit
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </DockShell>
  );
}

function EnableSwitch({
  on,
  disabled,
  label,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-45 ${
        on ? "bg-accent" : "bg-inset"
      }`}
    >
      <span
        className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow-sm transition-[left] ${
          on ? "left-[14px]" : "left-[2px]"
        }`}
      />
    </button>
  );
}
