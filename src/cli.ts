#!/usr/bin/env node
// The `trough` CLI: onboarding, human-only sharing commands, and the local bridge that
// lets other tools feed checkpoints/updates into the current session.
//
//   trough init                         onboarding: server, account, sharing default
//   trough <command> [args]             same as /trough <command> in a session (see HELP)
//   trough checkpoint --digest "..." [--card c-x] [--ref type=value ...]   bridge
//   trough update "text" [--card c-x]   bridge
//   trough sessions                     live sessions on this machine
//   trough <command> --session <nick>   target a specific one (else: found by ancestry / cwd)
//   trough hook                         Claude Code hook entry point (reads stdin)
//   trough mcp | steward                run the MCP server / steward server

import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { loadConfig, saveConfig, NOT_CONFIGURED, type ClientConfig } from "./config.ts";
import { register } from "./account.ts";
import { HELP, callLocal, findSocket, liveRegistrations, runCommand } from "./local.ts";
import { Session } from "./session.ts";

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function flags(name: string): string[] {
  return argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]!] : []));
}

/** A short-lived session for principal-level commands when no live session is around. */
async function ephemeral(cfg: ClientConfig): Promise<Session> {
  const s = new Session({ config: cfg, agent: "cli", handle: `cli-${randomBytes(2).toString("hex")}` });
  s.start();
  await s.irc.ready();
  await new Promise((r) => setTimeout(r, 300));
  return s;
}

async function init(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const existing = loadConfig();
  const ask = async (q: string, def?: string) => (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim() || def || "";
  const host = await ask("IRC server host", existing?.host ?? "localhost");
  const port = Number(await ask("Port", String(existing?.port ?? 6667)));
  const tls = (await ask("TLS? (y/n)", existing?.tls ? "y" : "n")).startsWith("y");
  const insecure = tls ? (await ask("Accept self-signed certs? (y/n)", existing?.insecure ? "y" : "n")).startsWith("y") : false;
  const principal = (await ask("Your name (the principal; lowercase, e.g. ed)", existing?.principal)).toLowerCase();
  const password = existing?.password ?? randomBytes(18).toString("base64url");
  const cfg: ClientConfig = { host, port, tls, insecure, principal, password };
  saveConfig(cfg);
  console.log(`Saved ~/.trough/config.json. ${await register(cfg)}`);
  const share = (await ask("Share new sessions with the team by default? (y/n)", "y")).startsWith("y");
  rl.close();
  const s = await ephemeral(cfg);
  // The steward server starts a steward for a new principal on its first hello; give it a moment.
  let ack = await s.control("default-shared", share);
  for (let i = 0; !ack && i < 5; i++) {
    s.hello();
    await new Promise((r) => setTimeout(r, 2_000));
    ack = await s.control("default-shared", share);
  }
  console.log(ack?.text ?? "Couldn't reach your steward yet; run `trough default-shared yes|no` later.");
  s.stop();
}

/** Returns true for long-running subcommands that must not be exited after main(). */
async function main(): Promise<boolean | void> {
  const cmd = argv[0] ?? "help";
  if (cmd === "init") return init();
  if (cmd === "mcp") {
    await import("./mcp.ts");
    return true;
  }
  if (cmd === "steward") {
    await import("./steward-main.ts");
    return true;
  }
  if (cmd === "hook") {
    const { runHook } = await import("./hook.ts");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const out = await runHook(input);
    if (out) process.stdout.write(out);
    return;
  }
  if (cmd === "statusline") {
    // Claude Code status line (reads its JSON on stdin, prints one line). Silent when this
    // agent isn't on trough, so it composes with other status-line scripts.
    let input = "";
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) input += chunk;
    let cwd: string | undefined;
    try {
      cwd = (JSON.parse(input) as { cwd?: string; workspace?: { current_dir?: string } }).workspace?.current_dir ?? JSON.parse(input).cwd;
    } catch {
      // not JSON: fine
    }
    const { findSocket: find, callLocal: call, statusSegment } = await import("./local.ts");
    const sock = find(cwd);
    if (!sock) return;
    const res = await call(sock, { op: "peek" }, 1_500).catch(() => undefined);
    if (res?.data) process.stdout.write(statusSegment(res.data as Parameters<typeof statusSegment>[0]));
    return;
  }
  if (cmd === "help" || cmd === "--help") {
    console.log(`${HELP.replaceAll("/trough", "trough")}\n  trough init\n  trough checkpoint --digest "..." [--card id] [--ref type=value]\n  trough update "text" [--card id]`);
    return;
  }
  const cfg = loadConfig();
  if (!cfg) {
    console.error(NOT_CONFIGURED);
    process.exit(1);
  }
  if (cmd === "register") {
    console.log(await register(cfg));
    return;
  }

  if (cmd === "sessions") {
    const live = liveRegistrations();
    console.log(live.length ? live.map((r) => `${r.nick}  ${r.agent}  ${r.cwd}  (since ${r.startedAt})`).join("\n") : "No live sessions on this machine.");
    return;
  }
  const named = flag("session");
  const socket = named ? liveRegistrations().find((r) => r.nick === named.toLowerCase())?.socket : findSocket(process.cwd(), { loneFallback: true });
  if (cmd === "checkpoint" || cmd === "update") {
    const refs = flags("ref").map((r) => {
      const [type, ...v] = r.split("=");
      return { type: type!, value: v.join("=") };
    });
    const data = cmd === "checkpoint" ? { digest: flag("digest"), card: flag("card"), title: flag("title"), refs } : { text: argv.filter((a, i) => i > 0 && !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).join(" "), card: flag("card") };
    if (socket) {
      console.log((await callLocal(socket, { op: cmd, data })).text);
      return;
    }
    const s = await ephemeral(cfg);
    const ack = cmd === "checkpoint" ? await s.checkpoint(data) : await s.update(String(data.text ?? ""), flag("card"));
    console.log(ack ? `Filed on ${ack.data?.card}.` : "Queued.");
    s.stop();
    return;
  }

  const line = argv.filter((a, i) => a !== "--session" && argv[i - 1] !== "--session").join(" ");
  if (socket) {
    console.log((await callLocal(socket, { op: "command", line })).text);
    return;
  }
  // No live session: principal-level commands still work through a short-lived one.
  // share/unshare need the target session: --session ed|cc-3f2a
  const s = await ephemeral(cfg);
  if ((cmd === "share" || cmd === "unshare") && flag("session")) {
    console.log((await s.control(cmd, undefined, flag("session")))?.text ?? "No answer from your steward.");
  } else if (cmd === "share" || cmd === "unshare") {
    console.log("No live session found from here; pass --session <nick> (see `trough status` inside the session).");
  } else {
    console.log(await runCommand(s, line));
  }
  s.stop();
}

main().then(
  (keepAlive) => {
    if (!keepAlive) setTimeout(() => process.exit(0), 50);
  },
  (e: Error) => {
    console.error(e.message);
    process.exit(1);
  },
);
