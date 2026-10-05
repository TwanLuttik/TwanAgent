import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectSkills,
  parseSkillMd,
  parseSkillsDisabled,
  setSkillEnabledInToml,
  skillFallbackName,
  skillPillSummary,
  skillSystemLine,
  type DetectedSkill,
} from "./skill.ts";

function skill(
  name: string,
  source: string,
  origin: DetectedSkill["origin"],
  enabled: boolean,
  description = "",
): DetectedSkill {
  return { name, source, origin, enabled, description };
}

describe("parseSkillMd", () => {
  it("reads name and description from frontmatter and falls back to the folder", () => {
    const parsed = parseSkillMd(
      "~/.grok/skills/commit/SKILL.md",
      `---
name: commit
description: Create conventional commits. Use when the user wants to commit.
---

# Commit
`,
      "commit",
    );
    assert.deepEqual(parsed, {
      name: "commit",
      source: "~/.grok/skills/commit/SKILL.md",
      origin: "user",
      enabled: true,
      description: "Create conventional commits. Use when the user wants to commit.",
    });
    assert.equal(skillFallbackName("~/.grok/skills/review-pr/SKILL.md"), "review-pr");
    assert.equal(skillFallbackName("~/.grok/commands/ship.md"), "ship");
    const fallback = parseSkillMd(".grok/skills/my_skill/SKILL.md", "# Hello\n\nDo the thing.\n", "my_skill");
    assert.equal(fallback?.name, "my-skill");
    assert.match(fallback?.description ?? "", /Do the thing/);
    assert.equal(fallback?.origin, "project");
  });

  it("returns nothing for empty files", () => {
    assert.equal(parseSkillMd("x/SKILL.md", "   ", "x"), null);
  });
});

describe("detectSkills", () => {
  it("keeps the first name, applies [skills].disabled, and skips vendor defaults", () => {
    const grokToml = `
[skills]
disabled = [
  "writing-skills",
]
`;
    const skills = detectSkills(
      [
        {
          source: ".grok/skills/commit/SKILL.md",
          origin: "project",
          contents: "---\nname: commit\ndescription: Commit.\n---\n",
        },
        {
          source: "~/.grok/skills/commit/SKILL.md",
          origin: "user",
          contents: "---\nname: commit\ndescription: User commit.\n---\n",
        },
        {
          source: "~/.grok/installed-plugins/p/skills/writing-skills/SKILL.md",
          origin: "plugin",
          contents: "---\nname: writing-skills\ndescription: Write skills.\n---\n",
        },
        {
          source: "~/.cursor/skills/shell/SKILL.md",
          origin: "cursor",
          contents: "---\nname: shell\ndescription: Vendor.\n---\n",
        },
      ],
      grokToml,
    );
    assert.deepEqual(
      skills.map((row) => ({ name: row.name, origin: row.origin, enabled: row.enabled, source: row.source })),
      [
        { name: "commit", origin: "project", enabled: true, source: ".grok/skills/commit/SKILL.md" },
        { name: "writing-skills", origin: "plugin", enabled: false, source: "~/.grok/installed-plugins/p/skills/writing-skills/SKILL.md" },
      ],
    );
  });
});

describe("setSkillEnabledInToml", () => {
  it("edits only [skills].disabled and leaves other tables alone", () => {
    const start = `disabled_mcp_servers = ["linear"]

[skills]
paths = []
disabled = [
  "writing-skills",
]

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`;
    assert.deepEqual(parseSkillsDisabled(start), ["writing-skills"]);
    const on = setSkillEnabledInToml(start, "writing-skills", true);
    assert.match(on, /disabled = \[\]/);
    assert.match(on, /disabled_mcp_servers = \["linear"\]/);
    const off = setSkillEnabledInToml(on, "brainstorming", false);
    assert.match(off, /"brainstorming"/);
    assert.doesNotMatch(off, /"writing-skills"/);
  });
});

describe("skill copy", () => {
  it("summarizes the pill and mentions skills to the agent", () => {
    const skills = [
      skill("commit", ".grok/skills/commit/SKILL.md", "project", true, "Commit."),
      skill("writing-skills", "~/.grok/skills/writing-skills/SKILL.md", "user", false),
    ];
    assert.equal(skillPillSummary([]), "");
    assert.equal(skillPillSummary(skills.slice(0, 1)), "Skills · commit");
    assert.equal(skillPillSummary(skills), "Skills · 1/2");
    assert.equal(skillSystemLine([]), "");
    const line = skillSystemLine(skills);
    assert.match(line, /not auto-loaded/);
    assert.match(line, /commit/);
    assert.match(line, /1 disabled/);
    assert.doesNotMatch(line, /writing-skills/);
  });
});
