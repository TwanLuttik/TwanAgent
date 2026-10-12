# Claude models implementation plan

> **For agentic workers:** Implement task-by-task with TDD. Do not commit unless the user asks. Do not start a task until the user accepts this plan. Task 1 is the exception: it is the catalog and key seam, and it starts with this plan.

**Goal:** Let the user pick a Claude model in the composer and chat with it through Anthropic's Messages API, using the same tool loop, transcript, and `dev-chat` events that Grok uses today.

**Architecture:** Chat is one xAI SSE client in `src-tauri/src/dev/chat.rs`. Keep that path. Add a provider on each model (`xai` or `anthropic`). `dev_chat_start` picks the client from the model id. The frontend still sends OpenAI-shaped messages from `toApiMessages()`. Rust translates those into a Messages API request and maps Anthropic SSE back onto `delta`, `reasoning`, `usage`, and `done`. Tool execution stays in `src/lib/agent.ts`.

**Tech stack:** Tauri 2, Rust, `reqwest` (already a dependency), React, node:test + cargo test. No Anthropic SDK.

## Global constraints

- Do not send a Claude model id to `api.x.ai` or the Grok CLI proxy.
- Do not send Grok auth, `x-grok-*` headers, or `X-XAI-Token-Auth` to Anthropic.
- Do not treat Grok CLI rows whose `model_family` is not `xai` as Claude models. `parse_models_cache` keeps dropping them.
- Anthropic auth is a separate keychain account, `anthropic`, on the existing service `app.twanagent.desktop` (debug: `app.twanagent.desktop.dev`). Never store it in the `xai` account or in `secrets.json`.
- Resolve the Anthropic key as: keychain, then `ANTHROPIC_API_KEY`. Do not fall back to the xAI key or the Grok CLI session.
- The Grok CLI terminal (`pty.rs`, `dev_pty_open_grok`) stays Grok-only.
- The agent loop, tool names, and `dev-chat` event shape do not change. Tool-call ids from Claude (`toolu_…`) are passed through.
- Do not send prior reasoning or thinking blocks back to either provider. `toApiMessages` already strips `reasoning`.
- No live API calls in tests. Translator and SSE tests use fixtures.
- Do not commit unless asked.

## Current code

- Model catalog, Grok auth, and endpoints: `src-tauri/src/grok_cli.rs`. `DevModel` has `id`, `name`, `efforts`, `context_window`, `context_windows`. `runtime()` only knows xAI.
- The only chat HTTP call is `dev_chat_start` → `stream_chat` in `src-tauri/src/dev/chat.rs`. It posts OpenAI chat completions and parses `choices[0].delta`.
- xAI keychain: `src-tauri/src/secrets.rs`, commands in `src-tauri/src/dev/keys.rs`.
- Frontend messages: `toApiMessages()` and `systemPrompt()` in `src/lib/core.ts`. Both assume Grok. The system prompt says "Only Grok is available".
- Saved model id: `twanagent.model` in `src/lib/prefs.ts`. Effort is `twanagent.effort`. Context size is `twanagent.contextWindow`.
- Context fallback in `src/lib/context.ts` is 500_000 tokens, which is wrong for Claude.
- Prices in `src/lib/usage.ts` are xAI only. An unknown model is "unpriced".
- Settings xAI key UI: `src/views/SettingsView.tsx`. Composer model chip: `src/components/Composer.tsx`.
- Subagents reuse `opts.model` in `src/lib/agent.ts` and still say "You are Grok" in `subagentSystemPrompt()`.

## Model catalog

Static list. Do not discover these from the Grok CLI cache.

| id | name | context | efforts |
|---|---|---|---|
| `claude-opus-4-8` | Claude Opus 4.8 | 200_000 | low, medium, high, xhigh, max |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | 200_000 | low, medium, high, xhigh, max |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 200_000 | low, medium, high |

`context_windows` stays empty so the context-size chip stays hidden. One window, no picker.

Effort maps to Anthropic `output_config.effort`. Request adaptive thinking (`thinking: { type: "adaptive" }`) on every Claude call so the existing reasoning transcript still fills. Do not send `budget_tokens`.

`max_tokens` is required by the Messages API. Use 32_000 for Opus and Sonnet, 16_000 for Haiku. This is the output cap, not the context window.

Default model stays the Grok CLI default when Grok can authenticate. A saved Claude id is kept only when an Anthropic key is available.

## Wire shape

Request: `POST https://api.anthropic.com/v1/messages`

Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`, `accept: text/event-stream`.

| OpenAI message from `toApiMessages` | Anthropic |
|---|---|
| `role: system` | top-level `system` string, removed from `messages` |
| user string | `{ role: "user", content: [{ type: "text", text }] }` |
| `image_url` data URL | `{ type: "image", source: { type: "base64", media_type, data } }` |
| assistant `tool_calls` | `{ type: "tool_use", id, name, input }` where `input` is parsed JSON |
| `role: tool` | a user message `{ type: "tool_result", tool_use_id, content }` |
| `tools[].function` | `{ name, description, input_schema }` |
| `tool_choice: "auto"` | `{ type: "auto" }` |
| `reasoning_effort` | `output_config.effort` |

SSE events to handle:

- `content_block_start` / `content_block_delta`: `text_delta` → `delta`, `thinking_delta` → `reasoning`, `input_json_delta` accumulated by content-block index.
- `message_delta.usage` and `message_start.usage`: `input_tokens` / `output_tokens` → the existing usage fields. `parse_usage` already accepts those aliases.
- `message_stop` → `done`, with any finished tool calls. There is no `[DONE]` line.
- HTTP 401 → `Anthropic rejected the API key.` Other failures keep the status and a short body.

## File map

- Create: `src-tauri/src/anthropic.rs` — catalog, key resolution hook, request translator, SSE mapper
- Create: `src/lib/provider.ts` — provider from model id, context fallback, prompt name
- Create: `src/lib/tests/provider.test.ts`
- Modify: `src-tauri/src/secrets.rs` — Anthropic keychain account
- Modify: `src-tauri/src/dev/keys.rs` — status and set/clear commands
- Modify: `src-tauri/src/grok_cli.rs` — `provider` on `DevModel`, merge Claude rows into `runtime()`
- Modify: `src-tauri/src/dev/chat.rs` — dispatch, do not rewrite the xAI streamer
- Modify: `src-tauri/src/lib.rs` — `mod anthropic` and the new commands
- Modify: `src/lib/tauri.ts` — `provider` on `Model`, key wrappers
- Modify: `src/lib/core.ts` — system prompt no longer claims only Grok exists
- Modify: `src/lib/subagent.ts` — same for the child prompt
- Modify: `src/lib/context.ts` — Claude window is 200_000
- Modify: `src/lib/usage.ts` — Anthropic list prices
- Modify: `src/views/SettingsView.tsx` — Anthropic API key section
- Modify: `src/components/Composer.tsx` — placeholders follow the selected provider

## Tasks

### Task 1: Catalog and Anthropic key

**Files:** `src-tauri/src/anthropic.rs`, `src-tauri/src/secrets.rs`, `src-tauri/src/dev/keys.rs`, `src-tauri/src/grok_cli.rs`, `src-tauri/src/lib.rs`, `src/lib/provider.ts`, `src/lib/tests/provider.test.ts`, `src/lib/tauri.ts`.

- `claude_models()` returns the three rows above. Each effort has the same short labels Grok uses (`Low`, `Medium`, `High`, `Extra high`) plus `Max` for `max`.
- `is_claude_model(id)` is true only for ids in that catalog. `claude-opus-4-8-latest` is not a match. An id that does not start with `claude-` is not a match.
- `provider_for(id)` returns `anthropic` for a catalog id and `xai` for everything else, including empty and `grok-*`.
- Add `provider: String` to `DevModel` and the TS `Model` type. Grok rows from the cache and the fallback list set `provider` to `xai`. `runtime()` appends the Claude catalog after the Grok rows. The Grok cache filter test still drops a non-xAI sample.
- `default_model` is unchanged: still the Grok CLI default. Claude does not become the default just because a key exists.
- Anthropic keychain uses account `anthropic`. `set` / `get` / `delete` follow the xAI helpers, including the debug-service copy, but they do not read or clear `xai_key` in `secrets.json`.
- Commands: `dev_anthropic_key_status`, `dev_set_anthropic_key`, `dev_clear_anthropic_key`. Status is `{ saved, env }` where `env` means `ANTHROPIC_API_KEY` is non-empty.
- `resolve_anthropic_key_on_disk` is keychain then env. A test proves an xAI key in the same store is not returned.
- TS: `providerFor(modelId)` and `contextWindowForProvider` live in `src/lib/provider.ts` so the catalog ids are not copied into `context.ts` yet. Task 4 wires the context helper.

**Done when:** cargo tests cover the catalog, provider classification, and key isolation. Node tests cover `providerFor`. `dev_runtime` includes the three Claude models with `provider: "anthropic"`. Chat still goes to xAI for every model, including a Claude id. That dispatch is Task 3, so Task 1 must not pretend Claude can reply yet.

### Task 2: Messages API translator

**Files:** `src-tauri/src/anthropic.rs`.

- `to_messages_body(messages, model, effort, include_journey)` returns the JSON body. It does not perform I/O.
- System messages are concatenated into top-level `system` and removed from `messages`. A compaction summary is already a user message by the time it reaches Rust (`toApiMessages` converts it). Do not special-case it here.
- User text stays text. A data URL `data:<mime>;base64,<payload>` becomes an image block. A non-data image URL is dropped rather than sent as a URL Anthropic would reject.
- Consecutive `role: tool` messages become one user message with one `tool_result` block each, in order.
- Assistant `tool_calls` become `tool_use` blocks. `arguments` must parse as a JSON object. Invalid JSON becomes `{ "raw": "<arguments>" }` so the request still sends. Empty argument strings become `{}`.
- An assistant message that has only tool calls sends no empty text block.
- Tools are the same list `tools_json` already builds, reshaped to `{ name, description, input_schema }`. Journey tool is included only when `include_journey` is true.
- `stream: true`, `max_tokens` from the catalog, `thinking: { type: "adaptive" }`. When `effort` is non-empty, set `output_config.effort` to that string. Do not invent an effort when the caller passed none.
- `max_tokens` for an unknown Claude id (should not happen after Task 1) is 16_000.

**Done when:** cargo tests cover system splitting, an image data URL, a tool round-trip (assistant tool_use + user tool_result), invalid tool arguments, the journey tool flag, and the effort / thinking fields. No network.

### Task 3: Dispatch and SSE

**Files:** `src-tauri/src/dev/chat.rs`, `src-tauri/src/anthropic.rs`.

- `dev_chat_start` resolves the provider from the model id before auth.
- `xai` keeps the current `resolve_auth` + `stream_chat` path, including its error text.
- `anthropic` calls `resolve_anthropic_key_on_disk`. If it is missing, return `Claude isn’t signed in. Add an Anthropic API key in Settings.` Do not fall through to Grok.
- Stream `POST /v1/messages` with the Task 2 body. Disable gzip the same way the xAI client does.
- Map SSE onto the existing `DevChatEvent` values. Accumulate tool arguments by content-block index. On `message_stop`, or when the body ends after any text, reasoning, or tool call, emit `done`.
- A stream error before any content is `error decoding response body: …`, matching the xAI branch. HTTP 401 uses the Anthropic key message above. Other HTTP errors are `Anthropic error {status}: {body}` trimmed to 400 characters.
- Cancel still flips the shared flag and emits `Stopped.`.
- `parse_sse` is a pure function over a chunk of text plus accumulator state, so tests do not need a server.

**Done when:** a fixture with text, thinking, a tool call, and usage emits `delta`, `reasoning`, `usage`, and `done` with the tool name and arguments. A second test shows `provider_for("claude-sonnet-4-6")` never selects the xAI endpoint helper. Existing xAI parser tests still pass.

### Task 4: Prompts, context, and prices

**Files:** `src/lib/core.ts`, `src/lib/subagent.ts`, `src/lib/context.ts`, `src/lib/usage.ts`, their tests.

- `systemPrompt` and `subagentSystemPrompt` take an optional model label. Empty or missing stays a coding agent without naming Grok. When the selected model is Claude, the line is `You are Claude, a coding agent in TwanAgent.` When it is Grok, `You are Grok, a coding agent in TwanAgent.` Delete the sentence `Only Grok is available — do not suggest other models.`
- Subagents already receive `opts.model`. Pass that model's display name into the child prompt. The child still uses the same model id (already true in `runSubagent`).
- `contextWindowForModel` returns 200_000 for a Claude catalog id before the 500_000 fallback. A catalog `context_window` still wins when the runtime provided one.
- Add list prices to `MODEL_RATES`, USD per million tokens. These are standard context prices, not the long-context tier:

  | id | input | output |
  |---|---|---|
  | `claude-opus-4-8` | 5 | 25 |
  | `claude-sonnet-4-6` | 3 | 15 |
  | `claude-haiku-4-5` | 1 | 5 |

- Do not set `cachedInput` or `longContextFrom` for Claude in this slice. Cached tokens are not stored on usage events, so fresh input pricing matches how Grok is estimated today when cache data is missing.

**Done when:** node tests show the prompt names Grok or Claude and never says only Grok is available; a Claude id resolves to a 200_000 window; `estimateUsageCost` prices a Claude event and a Grok event with their own rates.

### Task 5: Settings and composer

**Files:** `src/views/SettingsView.tsx`, `src/components/Composer.tsx`, `src/lib/tauri.ts`, `src/views/MainView.tsx`.

- Settings, on the Grok tab under the xAI key, add an Anthropic section:
  - Title: Anthropic
  - Text: Used for Claude models in the composer. Stored in the keychain.
  - Password field and Save / Clear, same behavior as the xAI key.
  - Status line: `Saved`, `Using ANTHROPIC_API_KEY`, or `Not set`.
- Changing the key refreshes `dev_runtime` so the composer can enable Claude models.
- The model chip lists Grok models first, then Claude. A Claude row whose provider is not ready is still visible. Choosing it and sending shows the Task 3 sign-in error. Do not hide models.
- Composer placeholder: `Ask Claude…` when the selected model is Anthropic, otherwise the current Grok placeholder. The signed-out placeholder follows the same provider.
- `applyRuntime` keeps a saved Claude id when that id is in `runtime.models`. It does not reset to `default_model` just because the default is Grok.

**Done when:** an Anthropic key can be saved and cleared without touching the xAI key, the model chip shows the three Claude models, and the placeholder follows the selection. A manual send with a Claude model and a valid key is the first live check. Do not automate that call.

## Suggested order

Task 1 is safe to land alone: the picker can show Claude, but chat still uses xAI until Task 3. Task 2 has no UI. Task 3 is the first time a Claude id stops hitting xAI. Task 4 fixes wrong context math and cost before people use it. Task 5 is the visible key and placeholder work and can follow Task 1 if a UI checkpoint is useful, but the placeholder copy depends on Task 4's provider naming.

## Out of scope

- Prompt caching (`cache_control`) and the 1M-token context beta.
- Claude CLI, Agent SDK, or a Claude PTY.
- Per-chat model override. Effort is per chat today. Model stays the global `twanagent.model` preference.
- Letting Grok CLI cache rows from another provider through the proxy.
- OpenAI or Gemini.
- Editing the system prompt beyond the provider name and the removed "only Grok" line.
