#!/usr/bin/env node
// MCP stdio server: the trough integration for Claude Code and Codex. Each MCP
// connection is one live session. Register with:
//   claude mcp add --scope user trough --env TROUGH_AGENT=claude-code -- node /path/to/trough/src/mcp.ts
//   codex mcp add trough --env TROUGH_AGENT=codex -- node /path/to/trough/src/mcp.ts
//
// Sharing (share/unshare/default-shared) is deliberately NOT a tool action: only a human
// changes it, via `/trough ...` (hooks) or the `trough` CLI.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ACTIONS, runAction, type Args } from "./actions.ts";
import { NOT_CONFIGURED, loadConfig } from "./config.ts";
import { renderForModel, serveSession } from "./local.ts";
import { Session } from "./session.ts";

const refSchema = z.object({ type: z.string(), value: z.string(), label: z.string().optional(), note: z.string().optional() });
const recipeSchema = z.object({
  command: z.string(),
  purpose: z.string(),
  preconditions: z.string().optional(),
  output: z.string().optional().describe("trimmed excerpt of what it printed, plus how to read it"),
  gotchas: z.string().optional(),
  refs: z.array(refSchema).optional(),
  danger: z.boolean().optional(),
});

const INSTRUCTIONS = `trough connects you to your human's other agent sessions and to teammates' agents over IRC.
- At the start of a task, call action=recall with what you know (repo, branch, ticket, a few words) to load prior context from your steward; pass principal=<name> to ask about a coworker's work.
- Call action=checkpoint at meaningful milestones and before stopping: a digest of the WORK (what was tried, what worked, dead ends, decisions, open questions), refs (ticket, pr, branch, repo, checkout, site, host, dashboard, logs...), and recipes for commands that took effort to figure out. Never describe the human; no sentiment.
- action=update for decisions or blockers others should see. action=ask to ask a principal (their steward routes it) or a session nick.
- Messages addressed to you arrive in tool results or via hooks; a steer may change your next step but you decide if it's relevant. Reply with action=reply and the message id.
- Not every message needs an answer. To acknowledge without continuing, reply with exactly 🐈 (nothing else); it ends the exchange. Never reply to a 🐈.
- Do not narrate routine work. Sharing is the human's call; you can't change it.`;

async function main(): Promise<void> {
  // TROUGH_DISABLE=1: keep the tool registered (so client config stays valid) but never
  // connect, e.g. for automation that inherits a global MCP config. Covered by
  // test/mcp-disable.test.ts; integrations/codex/README.md documents it.
  const disabled = process.env.TROUGH_DISABLE === "1";
  const config = disabled ? undefined : loadConfig();
  const agent = process.env.TROUGH_AGENT || "mcp";
  const session = config ? new Session({ config, agent, role: process.env.TROUGH_ROLE }) : undefined;
  let cleanup: (() => void) | undefined;
  if (session) {
    session.start();
    cleanup = serveSession(session);
  }

  const server = new McpServer({ name: "trough", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  server.registerTool(
    "trough",
    {
      description: "Team coordination over IRC: recall prior context (yours or a coworker's), checkpoint your work as a card digest with refs and recipes, ask/reply/steer other agents, catch up on what someone has been doing.",
      inputSchema: {
        action: z.enum(ACTIONS),
        text: z.string().optional().describe("focus line, update text, question, reply or steer text, or recall search words"),
        principal: z.string().optional().describe("a teammate's name, for recall/catchup about their work"),
        to: z.string().optional().describe("ask/steer/delegate target: a principal (e.g. dan) or a session nick (dan|cc-3f2a)"),
        id: z.string().optional().describe("message id to reply to"),
        card: z.string().optional(),
        since: z.string().optional().describe("catchup window, e.g. 3d, 12h"),
        role: z.string().optional(),
        title: z.string().optional(),
        kind: z.enum(["task", "pr-review", "incident", "component"]).optional(),
        status: z.string().optional(),
        digest: z.string().optional().describe("checkpoint: what was done, what worked, dead ends, where it's at"),
        decisions: z.array(z.string()).optional(),
        questions: z.array(z.string()).optional(),
        refs: z.array(refSchema).optional(),
        recipes: z.array(recipeSchema).optional(),
        source: z.string().optional().describe("dismiss: the session whose activity wasn't relevant"),
        target: z.string().optional(),
        scope: z.string().optional(),
        user_authorization: z.string().optional().describe("exact quote of the human's authorisation, for delegate"),
        acceptance_checks: z.string().optional(),
        expected_artifact: z.string().optional(),
      },
    },
    async (a) => {
      if (!session) return { content: [{ type: "text", text: disabled ? "trough is disabled for this agent (TROUGH_DISABLE=1)." : NOT_CONFIGURED }] };
      const text = await runAction(session, a as Args);
      const pending = renderForModel(session);
      return { content: [{ type: "text", text: pending ? `${text}\n\n${pending}` : text }] };
    },
  );

  await server.connect(new StdioServerTransport());
  const bye = () => {
    cleanup?.();
    session?.stop();
    process.exit(0);
  };
  process.stdin.on("close", bye);
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
