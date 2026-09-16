import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parsePermissionMode,
  permissionLabel,
  permissionSystemLine,
  shouldPromptShell,
  toolDeniedByPermission,
} from "./dev-permission.ts";

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
    assert.equal(toolDeniedByPermission("ask", "write_file"), null);
    assert.equal(toolDeniedByPermission("approve-all", "run_command"), null);
  });

  it("labels modes for the composer chip", () => {
    assert.equal(permissionLabel("ask"), "Ask");
    assert.equal(permissionLabel("approve-all"), "Approve all");
    assert.equal(permissionLabel("read-only"), "Read only");
  });

  it("describes the policy in the system prompt", () => {
    assert.match(permissionSystemLine("ask"), /require the user to approve/);
    assert.match(permissionSystemLine("approve-all"), /without asking/);
    assert.match(permissionSystemLine("read-only"), /Read-only/);
  });
});
