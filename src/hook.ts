// Claude Code hook (UserPromptSubmit + PostToolUse). Finds this session's trough socket
// and either runs a human `/trough ...` command (blocking the prompt so the model never
// sees it) or injects queued inject-level messages as additional context.
// Silent and fast when there's no session or nothing queued. Never blocks a tool call.

import { callLocal, findSocket } from "./local.ts";

interface HookInput {
  hook_event_name?: string;
  prompt?: string;
}

/**
 * Stop the prompt before the model sees it and show `text` to the human.
 * `continue: false` + `stopReason` rather than `decision: "block"`, which Claude Code
 * renders as an orange "operation blocked by hook" warning that echoes the prompt.
 */
function answerHuman(text: string): string {
  return JSON.stringify({ continue: false, stopReason: text, suppressOutput: true });
}

const COMMAND_RE = /^\s*(?:\/trough|TROUGH_COMMAND:?)\s*(.*)$/s;

export async function runHook(stdin: string): Promise<string | undefined> {
  let input: HookInput = {};
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return undefined;
  }
  const socket = findSocket();
  const event = input.hook_event_name ?? "";
  const cmd = event === "UserPromptSubmit" ? COMMAND_RE.exec(input.prompt ?? "") : null;
  if (cmd) {
    if (!socket) return answerHuman("trough: no live session found for this Claude Code instance (is the trough MCP server registered and connected?)");
    const res = await callLocal(socket, { op: "command", line: cmd[1] ?? "" }).catch((e: Error) => ({ ok: false, text: e.message }));
    return answerHuman(res.text);
  }
  if (!socket) return undefined;
  const res = await callLocal(socket, { op: "drain" }, 3_000).catch(() => undefined);
  if (!res?.inject) return undefined;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: res.inject } });
}
