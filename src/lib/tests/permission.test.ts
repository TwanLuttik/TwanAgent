import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePermissionMode,
  permissionDetail,
  permissionEffect,
  permissionLabel,
  permissionSystemLine,
  remoteWorkspaceLine,
  shellApprovalLabel,
  shouldPromptShell,
  toolDeniedByPermission,
} from "../permission.ts";

describe("parsePermissionMode", () => {
  it("accepts known modes and falls back to ask", () => {
    assert.equal(parsePermissionMode("ask"), "ask");
    assert.equal(parsePermissionMode("approve-all"), "approve-all");
    assert.equal(parsePermissionMode("read-only"), "read-only");
    assert.equal(parsePermissionMode("yolo"), "ask");
    assert.equal(parsePermissionMode(""), "ask");
    assert.equal(parsePermissionMode(null), "ask");
  });
});

describe("permission policy", () => {
  it("only prompts for shell in ask mode", () => {
    assert.equal(shouldPromptShell("ask"), true);
    assert.equal(shouldPromptShell("approve-all"), false);
    assert.equal(shouldPromptShell("read-only"), false);
  });

  it("blocks writes and shell in read-only mode", () => {
    assert.equal(toolDeniedByPermission("read-only", "write_file"), "Error: write_file is blocked in read-only mode.");
    assert.equal(toolDeniedByPermission("read-only", "edit_file"), "Error: edit_file is blocked in read-only mode.");
    assert.equal(toolDeniedByPermission("read-only", "run_command"), "Error: run_command is blocked in read-only mode.");
    assert.equal(toolDeniedByPermission("read-only", "read_file"), null);
    assert.equal(toolDeniedByPermission("read-only", "web_search"), null);
    assert.equal(toolDeniedByPermission("read-only", "todo_write"), null);
    assert.equal(toolDeniedByPermission("ask", "write_file"), null);
    assert.equal(toolDeniedByPermission("approve-all", "run_command"), null);
  });

  it("shows what each mode allows", () => {
    assert.equal(permissionEffect("ask", "read"), "allow");
    assert.equal(permissionEffect("ask", "edit"), "allow");
    assert.equal(permissionEffect("ask", "shell"), "ask");
    assert.equal(permissionEffect("approve-all", "shell"), "allow");
    assert.equal(permissionEffect("read-only", "read"), "allow");
    assert.equal(permissionEffect("read-only", "edit"), "block");
    assert.equal(permissionEffect("read-only", "shell"), "block");
  });

  it("labels modes for the composer chip", () => {
    assert.equal(permissionLabel("ask"), "Ask");
    assert.equal(permissionLabel("approve-all"), "Approve all");
    assert.equal(permissionLabel("read-only"), "Read only");
    assert.match(permissionDetail("ask"), /approval/);
    assert.match(permissionDetail("approve-all"), /without asking/);
    assert.match(permissionDetail("read-only"), /not edit/);
  });

  it("describes the policy in the system prompt", () => {
    assert.match(permissionSystemLine("ask"), /require the user to approve/);
    assert.match(permissionSystemLine("approve-all"), /without asking/);
    assert.match(permissionSystemLine("read-only"), /Read-only/);
    assert.match(permissionSystemLine("read-only"), /Web search is allowed/);
  });

  it("names the server for a remote workspace and stays quiet locally", () => {
    assert.equal(remoteWorkspaceLine(null), "");
    assert.match(remoteWorkspaceLine({ machineName: "Build", remotePath: "/srv/billing" }), /Build/);
    assert.match(remoteWorkspaceLine({ machineName: "Build", remotePath: "/srv/billing" }), /\/srv\/billing/);
    assert.doesNotMatch(remoteWorkspaceLine({ machineName: "Build", remotePath: "/srv/billing" }), /ssh /);
    assert.equal(shellApprovalLabel("npm test"), "Run this command?");
    assert.equal(shellApprovalLabel("npm test", "Build"), "Run this command on Build?");
  });
});
