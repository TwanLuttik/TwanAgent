//! Tool definitions sent to the model.
//!
//! The names and argument shapes are the contract the React client and the turn loop share.
//! Adding a tool means a schema here and a match arm in `local_turn`.

fn journey_tool_json() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "update_journey_knowledge",
            "description": "Update this Journey's shared knowledge markdown. Use replace for a full rewrite, or edit to change one unique passage.",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": { "type": "string", "enum": ["replace", "edit"] },
                    "contents": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" }
                },
                "required": ["mode"]
            }
        }
    })
}

const PLAN_TOOL_NAMES: &[&str] = &["enter_plan_mode", "exit_plan_mode"];

pub(crate) fn tools_json(include_journey: bool) -> serde_json::Value {
    tools_json_for(include_journey, true)
}

/// Claude chats do not get Grok's plan-mode tools. The gate lives in the client too.
pub(crate) fn tools_json_for(include_journey: bool, include_plan: bool) -> serde_json::Value {
    let mut tools = base_tools_json();
    if !include_plan {
        if let Some(list) = tools.as_array_mut() {
            list.retain(|tool| {
                tool.get("function")
                    .and_then(|row| row.get("name"))
                    .and_then(|name| name.as_str())
                    .is_none_or(|name| !PLAN_TOOL_NAMES.contains(&name))
            });
        }
    }
    if include_journey {
        if let Some(list) = tools.as_array_mut() {
            list.push(journey_tool_json());
        }
    }
    tools
}

fn base_tools_json() -> serde_json::Value {
    serde_json::json!([
        {
            "type": "function",
            "function": {
                "name": "list_dir",
                "description": "List files and folders relative to the workspace root.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Relative folder path. Empty for the workspace root." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "grep",
                "description": "Search file contents in the workspace. Returns matching lines as path:line:text. The pattern is a case-insensitive substring, not a regular expression. Every text file is searched, including .ts and .tsx, unless glob says otherwise. Skips node_modules, target, dist, build, and .git. A miss means the substring was not found. It does not mean a file type was skipped. Use this to find a symbol instead of listing folders or running a shell search.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Literal text to find. Matched case-insensitively. Not a regular expression: dots and brackets match themselves." },
                        "path": { "type": "string", "description": "Folder or file relative to the workspace. Empty searches the whole workspace." },
                        "glob": { "type": "string", "description": "Optional file glob, such as *.rs, *.ts, or src/**/*.tsx. * matches any file name, including .ts and .tsx. Empty searches every text file." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "glob",
                "description": "Find files and folders by path pattern. Returns workspace-relative paths. Skips node_modules, target, dist, build, and .git. Use this to find files by name instead of listing the tree.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob such as **/*.ts or src/**/mod.rs. * stays in one segment. ** crosses folders." },
                        "path": { "type": "string", "description": "Folder relative to the workspace. Empty starts at the workspace root." }
                    },
                    "required": ["pattern"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a UTF-8 text file in the workspace. Optional offset and limit return a 1-based line range. Use them for large files instead of reading everything. Returned lines are prefixed with their line numbers.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "offset": { "type": "integer", "description": "1-based starting line. Omit to start at line 1." },
                        "limit": { "type": "integer", "description": "Max number of lines to return. Omit to read to the end." }
                    },
                    "required": ["path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Create or overwrite a UTF-8 text file in the workspace. Creates parent folders.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "contents": { "type": "string" }
                    },
                    "required": ["path", "contents"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Replace one unique occurrence of old_string with new_string in a file.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_string": { "type": "string" },
                        "new_string": { "type": "string" }
                    },
                    "required": ["path", "old_string", "new_string"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_status",
                "description": "Show git status for the workspace.",
                "parameters": { "type": "object", "properties": {} }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_diff",
                "description": "Show the git diff. Pass a relative path to limit it to one file. Pass a commit hash to show that commit.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "commit": { "type": "string", "description": "Optional commit hash. Omit for the working tree." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_log",
                "description": "Recent commits for this workspace: hash, author, date, subject.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "limit": { "type": "integer", "description": "How many commits. Defaults to 20, max 80." }
                    }
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "git_commit",
                "description": "Stage the given paths and commit them. Only call this when the user asked to commit. Requires a message.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": { "type": "string" },
                        "paths": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Workspace-relative paths to stage. Empty stages everything already listed by git status."
                        }
                    },
                    "required": ["message"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Search the web for current information. Use for facts, news, docs, and anything that may have changed since training. Returns a short answer with source URLs.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query. Be specific and include versions or dates when they matter."
                        },
                        "allowed_domains": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Optional domains to limit the search to, at most 5. Omit to search the whole web. Ignored when the user configured a domain policy."
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "run_command",
                "description": "Run a shell command in the workspace. The user must approve it first. Always set description to one short sentence of what the command does. That sentence is the chat line. A command runs in the foreground and this tool waits for it. End the command with & only when it should keep running after the tool returns, such as a dev server, file watcher, or other long-lived process. That is the only way a command stays open above the input.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string" },
                        "description": { "type": "string", "description": "One short sentence shown in the chat, such as \"Run membership UI tests\"." }
                    },
                    "required": ["command", "description"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "spawn_subagent",
                "description": "Start a child agent with its own context for a delegated task. Use for research, planning, or independent work. The child reports a summary when it finishes. Explore cannot edit files. Plan produces a plan without edits. General-purpose may edit. The child uses the same model as this chat.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "Full task prompt for the child." },
                        "description": { "type": "string", "description": "Short 3-5 word label shown in the UI." },
                        "subagent_type": {
                            "type": "string",
                            "enum": ["general-purpose", "explore", "plan"],
                            "description": "explore investigates, plan writes a plan, general-purpose can edit."
                        }
                    },
                    "required": ["prompt", "description"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "enter_plan_mode",
                "description": "Switch to plan mode. In plan mode, you can only read the codebase and write a plan. The user approves the plan before you change any code. Use this tool only when the user asks for a plan.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "exit_plan_mode",
                "description": "Show your plan to the user for approval. Plan mode ends when the user approves the plan.",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "todo_write",
                "description": "Create or update the step list shown above the user's input. Use for multi-step work. Call at the start of a turn or mid-turn as you progress. Keep at most one item in_progress.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "merge": {
                            "type": "boolean",
                            "description": "If true, merge by id into the current list. If false, replace the list. Defaults to true."
                        },
                        "todos": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": { "type": "string" },
                                    "content": { "type": "string" },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending", "in_progress", "completed", "cancelled"]
                                    }
                                },
                                "required": ["id", "content", "status"]
                            }
                        }
                    },
                    "required": ["todos"]
                }
            }
        }
    ])
}
