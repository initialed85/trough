# Claude Code

## Try it without touching your global config

```sh
cd ~/Projects/Home/trough        # .claude/commands/trough.md gives you /trough here
claude --mcp-config integrations/claude-code/mcp.json --settings integrations/claude-code/hooks.json
```

Add `--strict-mcp-config` to load only trough (no other MCP servers) for a clean test.
`mcp.json` has an absolute path to this checkout; adjust it if yours lives elsewhere.

## Permanent setup

1. MCP server (one live session per Claude Code instance):

   ```sh
   claude mcp add --scope user trough --env TROUGH_AGENT=claude-code -- node ~/Projects/Home/trough/src/mcp.ts
   ```

2. Hooks: merge `hooks.json` into `~/.claude/settings.json`. `UserPromptSubmit` runs `/trough ...` commands
   (blocking the prompt, so the model never sees them) and injects queued messages; `PostToolUse` delivers a
   `steer` mid-turn, at the next tool call.

3. Slash command: copy `commands/trough.md` to `~/.claude/commands/` so `/trough` autocompletes. The hook
   matches both `/trough ...` and the expanded `TROUGH_COMMAND: ...` text.

Unverified so far: whether Claude Code hands `UserPromptSubmit` the raw `/trough ...` text or the expanded
command body. The hook handles both; if neither arrives, the command file tells the model to say so.
