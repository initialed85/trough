# AGENTS.md

trough: agent-to-agent (and human) coordination over IRC. Read these first, in order:

1. `docs/PROTOCOL.md`: the design (what and why). It's the contract; if the code disagrees, the code is
   either a bug or a known gap listed in `docs/ARCHITECTURE.md`.
2. `docs/ARCHITECTURE.md`: how the design maps onto files, the wire format, and what isn't built yet.
3. `README.md`: what we tell humans (setup, commands).

## Commands

```sh
npm ci                                  # once
npm run check                           # typecheck + unit tests; run before calling anything done
scripts/test-ergo.sh up                 # throwaway Ergo on :16667 (Docker)
npm run test:integration                # end-to-end against it: steward server + two principals
scripts/test-ergo.sh down

docker build -t trough-steward:dev .    # steward image for the local cluster
kubectl --context colima apply -k deploy/k8s/local      # or --context docker-desktop
node scripts/smoke.ts 127.0.0.1:6667    # smoke-test a deployed trough
```

Always pass `--context` to kubectl. The human's kubeconfig holds production clusters; never rely on the
current context.

## Layout

| Path | What |
| --- | --- |
| `src/protocol.ts` | Wire format (envelopes over TAGMSG/PRIVMSG + `+tr/` tags), nicks, authenticity, shared types |
| `src/irc.ts` | Minimal IRCv3 client (CAP, SASL PLAIN, tags, reconnect). No IRC library on purpose |
| `src/store.ts` | Steward's per-principal card store: append-only JSONL event logs, visibility filtering |
| `src/match.ts` | Ref/keyword matching: finding a card from context, relevance tiers 1-2 |
| `src/steward.ts` | Steward logic over a `Transport` (unit-testable without IRC) |
| `src/steward-main.ts` | Steward server process: one connection per principal, starts stewards on demand |
| `src/session.ts` | A live agent session: connection, WAL, request/response, inject + drawer queues |
| `src/delivery.ts` | Delivery levels: inject / drawer / silent |
| `src/local.ts` | Unix-socket bridge (hooks, CLI, other tools), `/trough` command handling, model rendering |
| `src/actions.ts` | Shared `trough` action handlers for MCP and Pi |
| `src/mcp.ts` | MCP server for Claude Code / Codex: the `trough` tool |
| `src/hook.ts`, `src/cli.ts` | Claude Code hook; `trough` CLI (onboarding, human commands, bridge) |
| `src/scrub.ts`, `src/wal.ts`, `src/llm.ts`, `src/config.ts`, `src/account.ts` | Secret scrub, write-ahead log, optional small model, client config, account registration |
| `test/*.test.ts` | Unit tests (node:test). `test/integration/` needs a real Ergo |
| `deploy/k8s/base`, `deploy/k8s/local` | Kustomize base + local overlay. `deploy/README.md` for real clusters |
| `integrations/` | Per-client setup: Claude Code, Codex and the Pi extension |

## Conventions

- TypeScript run directly by Node >= 22.18 (type stripping). **Erasable syntax only**: no `enum`, no
  `namespace`, no parameter properties; imports use the `.ts` extension. `tsc` only typechecks.
- Two runtime deps (`@modelcontextprotocol/sdk`, `zod`). Think hard before adding a third.
- Match the surrounding code: small modules, short comments that explain *why*, `node:test` + `assert/strict`.
- Tests are the contract for behaviour in `docs/PROTOCOL.md` "Key flows". Add a steward test (fake
  transport, see `test/steward.test.ts`) for any new flow, and extend the e2e test if it crosses IRC.

## Invariants (don't break these)

- **The steward is the only writer** of its principal's cards. Sessions send; they never write the store.
- **Scrub before anything leaves the machine**: every outgoing text/data goes through `scrub`/`scrubDeep`
  in `Session`. Raw session logs are never sent anywhere.
- **Only a human changes sharing.** `share`, `unshare` and `default-shared` are `/trough` commands and CLI
  commands, never `trough` tool actions.
- **Trust comes from the account tag**, not the nick: `isAuthentic()` gates every protocol message.
- **Never inject a roster or pulse every turn.** Only inject-level items reach the model (`delivery.ts`).
- **WAL replays must be idempotent**: the steward dedupes on envelope id (`store.hasFiled`).
- Message kinds live in `KINDS` (`src/protocol.ts`) and in `docs/PROTOCOL.md` "Message kinds"; keep both in
  step. Internal kinds (`ack`, `control`, `note`) are documented in `docs/ARCHITECTURE.md`.

## Recipes for common changes

- **New ref type**: nothing to register; optionally add a weight in `match.ts` `WEIGHT` and a row in
  `docs/PROTOCOL.md` "Refs".
- **New card event**: add it to the `CardEvent` union in `store.ts`, fold it in `view()`, emit it from
  `steward.ts`, test it in `test/steward.test.ts`.
- **New tool action**: add it to `ACTIONS` and `runAction()` in `src/actions.ts`, plus the MCP and Pi schemas; if it needs the steward, add a `Session`
  method and a steward handler.
- **Ergo config change**: edit `scripts/gen-ergo-config.py` and regenerate (command in its docstring). Don't
  hand-edit `deploy/k8s/base/ergo/ircd.yaml`, and don't use `ERGO__` env overrides (several nested ones fail
  silently).
