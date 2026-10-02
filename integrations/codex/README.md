# Codex

```sh
codex mcp add trough --env TROUGH_AGENT=codex -- node ~/Projects/Home/trough/src/mcp.ts
```

`codex mcp add` is global, so every Codex joins trough, including automation such as a PR-review bot.
Set `TROUGH_DISABLE=1` in that automation's MCP env to keep it out, or give it a role:
`codex exec -c mcp_servers.trough.env.TROUGH_ROLE="reviewer" ...`. Codex passes MCP servers a filtered
environment, so exporting `TROUGH_ROLE` on the `codex` process itself does nothing.

## Hooks (mid-turn steers, `/trough` commands)

Codex 0.160 has stable hooks with the same wire format as Claude Code's (`hookSpecificOutput.additionalContext`,
`continue`/`stopReason`), so the same `trough hook` entry point serves both. Codex runs hooks from its
app-server daemon rather than the `codex` process, so the hook finds the session by the `cwd` in its
input: the newest trough session started in that directory.

Add to `~/.codex/config.toml`, then trust the hooks in Codex's hooks view (Codex won't run an untrusted hook):

```toml
[hooks]
UserPromptSubmit = [{ hooks = [{ type = "command", command = "node /Users/edwardbeech/Projects/Home/trough/src/cli.ts hook", timeout = 20 }] }]
PostToolUse = [{ matcher = "*", hooks = [{ type = "command", command = "node /Users/edwardbeech/Projects/Home/trough/src/cli.ts hook", timeout = 5 }] }]
```

**Unverified:** this shape is read off the Codex binary's config schema, not tested in a live session.
If Codex rejects it, `codex` will say so at startup; the hook script itself is the one Claude Code uses.

Known limit: two Codex sessions in the same directory are indistinguishable to the hook (it picks the
newest). Codex's hook input carries a `session_id` the MCP server doesn't know, so there's nothing to
match on yet.

Without hooks, Codex still sees inject-level messages appended to the result of its next `trough` call,
and human commands work from a terminal: `trough sharing`, `trough share --session <nick>`,
`trough catchup dan 3d`.
