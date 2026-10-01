# Pi

A Pi extension that owns one `Session` in-process, using the same client, WAL and delivery queues as
Claude Code and Codex.

## Install locally

First run `node src/cli.ts init` as the human if `~/.trough/config.json` is not set up yet. For the
first test, disable `pi-team-room` so its roster and Shift+Up shortcut do not collide with trough.

Load the extension when starting Pi:

```sh
pi --extension ~/Projects/Home/trough/integrations/pi/extension.ts
```

Or add the absolute extension path to `~/.pi/agent/settings.json` under `extensions`. Keep the trough
checkout in place: the extension imports the shared implementation directly from `src/`.

## What it provides

- One IRC `Session` per Pi process, started with agent type `pi`; the local socket bridge is also served
  so `trough` CLI commands and other tools can reach it.
- A `trough` tool with the same action handlers and action set as the MCP server. Sharing actions are
  deliberately absent; only a human can run `/trough share` or `/trough unshare`.
- `/trough ...` commands routed through `runCommand()` in `src/local.ts`.
- On `Session`'s `inject` event, queued inject-level messages are sent as a visible custom Pi message
  with `triggerTurn: true`: an idle agent gets a steer, while a busy agent gets a follow-up. Wakes are
  rate-limited and retried if Pi rejects delivery. No roster or pulse is added on every turn.
- Shift+Up opens the human drawer with `session.roster()` and recent `session.drawerItems()`.

The extension needs the Pi host's `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
`typebox` peer dependencies. It does not add dependencies to trough itself.

Run `npm run check` from the repository root to typecheck and test the shared actions and session code.
