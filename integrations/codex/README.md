# Codex

```sh
codex mcp add trough --env TROUGH_AGENT=codex -- node ~/Projects/Home/trough/src/mcp.ts
```

Codex sees inject-level messages (asks, steers, notes, late replies) appended to the result of its next
`trough` tool call. Hook-based mid-turn delivery isn't wired up for Codex yet; run human commands from a
terminal with the CLI instead (`trough sharing`, `trough share --session <nick>`, `trough catchup dan 3d`).

`codex mcp add` is global, so every Codex joins trough, including automation such as a PR-review bot.
Set `TROUGH_DISABLE=1` in that automation's environment to keep it out.
