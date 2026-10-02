// The local bridge: a unix socket each running session listens on, so hooks, the CLI and
// other tools on this machine can reach it (docs/PROTOCOL.md "Bridges, not rewrites").
//
// Discovery, in order:
//   1. TROUGH_SESSION_SOCKET, if set.
//   2. Ancestors: a session registers its socket under its parent process ids (the agent
//      client), and a hook/CLI run by that client walks up its own ancestors. Works for
//      Claude Code, which spawns MCP servers itself.
//   3. Working directory: Codex spawns MCP servers from a shared app-server daemon, so
//      ancestry doesn't connect them; match the newest live session started in this cwd.
//   4. The only live session, if there's exactly one, and only when the caller is a human at
//      the CLI (`loneFallback`). Never for hooks/status lines: an unrelated agent would
//      otherwise drain another session's messages.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";
import { troughHome } from "./config.ts";
import type { Session } from "./session.ts";
import { parseDuration } from "./protocol.ts";

export function runDir(): string {
  return join(troughHome(), "run");
}

function parentOf(pid: number): number | undefined {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const n = Number(out);
    return n > 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

function ancestors(start: number, depth: number): number[] {
  const out: number[] = [];
  let pid: number | undefined = start;
  while (pid && out.length < depth) {
    out.push(pid);
    pid = parentOf(pid);
  }
  return out;
}

interface Registration {
  nick: string;
  pid: number;
  cwd: string;
  agent: string;
  socket: string;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function liveRegistrations(): Registration[] {
  let files: string[] = [];
  try {
    files = readdirSync(runDir()).filter((f) => f.endsWith(".session.json"));
  } catch {
    return [];
  }
  return files
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(runDir(), f), "utf8")) as Registration];
      } catch {
        return [];
      }
    })
    .filter((r) => alive(r.pid) && existsSync(r.socket))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "login", "tmux", "screen"]);

function commandName(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim().replace(/^-/, "").split("/").at(-1) ?? "";
  } catch {
    return "";
  }
}

/** Array filter: keep pids until the first shell, then drop the rest. */
function notShellUntil(): (pid: number) => boolean {
  let hitShell = false;
  return (pid) => {
    if (hitShell) return false;
    if (SHELLS.has(commandName(pid))) hitShell = true;
    return !hitShell;
  };
}

export function findSocket(cwd = process.cwd(), opts: { loneFallback?: boolean } = {}): string | undefined {
  if (process.env.TROUGH_SESSION_SOCKET) return process.env.TROUGH_SESSION_SOCKET;
  for (const pid of ancestors(process.ppid, 8)) {
    const p = join(runDir(), `${pid}.sock`);
    if (existsSync(p)) return p;
  }
  const live = liveRegistrations();
  const here = live.find((r) => r.cwd === cwd) ?? live.find((r) => cwd.startsWith(`${r.cwd}/`));
  if (here) return here.socket;
  return opts.loneFallback && live.length === 1 ? live[0]!.socket : undefined;
}

/** Serve the session on a socket; returns a cleanup function. */
export function serveSession(session: Session): () => void {
  mkdirSync(runDir(), { recursive: true, mode: 0o700 });
  const base = join(runDir(), session.nick.replace("|", "_"));
  const primary = `${base}.session.sock`;
  const registration = `${base}.session.json`;
  try {
    unlinkSync(primary);
  } catch {
    // not there
  }
  const server: Server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as { op: string; line?: string; data?: Record<string, unknown> };
      const res = await handleLocal(session, req).catch((e: Error) => ({ ok: false, text: e.message }));
      sock.end(`${JSON.stringify(res)}\n`);
    });
  });
  server.listen(primary);
  const reg: Registration = { nick: session.nick, pid: process.pid, cwd: process.cwd(), agent: session.agent, socket: primary, startedAt: new Date().toISOString() };
  writeFileSync(registration, `${JSON.stringify(reg)}\n`);
  // Register under our own pid (in-process integrations like Pi: the agent IS this
  // process) and our ancestors up to the first shell (MCP servers: the agent client is
  // the parent). Never a shell: anything else started from that terminal would resolve here.
  const links = [process.pid, ...ancestors(process.ppid, 2).filter(notShellUntil())].map((pid) => join(runDir(), `${pid}.sock`));
  for (const l of links) {
    try {
      unlinkSync(l);
    } catch {
      // not there
    }
    try {
      symlinkSync(primary, l);
    } catch {
      // best effort
    }
  }
  return () => {
    server.close();
    for (const p of [primary, registration]) {
      try {
        unlinkSync(p);
      } catch {
        // gone
      }
    }
    // Only remove ancestor links that still point at us: a sibling MCP process under the
    // same parent (clients sometimes start a short-lived probe) may have replaced them.
    for (const l of links) {
      try {
        if (readlinkSync(l) === primary) unlinkSync(l);
      } catch {
        // gone
      }
    }
  };
}

export async function callLocal(socket: string, req: Record<string, unknown>, timeoutMs = 15_000): Promise<{ ok: boolean; text: string; inject?: string; data?: unknown }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socket);
    let buf = "";
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error("trough session didn't answer"));
    }, timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (c: string) => (buf += c));
    sock.on("end", () => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(buf));
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

export interface Peek {
  nick: string;
  connected: boolean;
  shared?: boolean;
  waiting: number;
  kinds: string[];
  cards: string[];
  around: number;
}

export function peek(session: Session): Peek {
  const waiting = session.peekInject();
  return { nick: session.nick, connected: session.irc.isRegistered, shared: session.shared, waiting: waiting.length, kinds: [...new Set(waiting.map((i) => i.kind))], cards: [...session.cards], around: session.roster().length };
}

/** One short status-line segment, e.g. "trough ⚑2 steer · shared · 3 around". */
export function statusSegment(p: Peek): string {
  const parts = [p.connected ? "trough" : "trough (offline)"];
  if (p.waiting) parts[0] += ` ⚑${p.waiting} ${p.kinds.join("/")}`;
  parts.push(p.shared ? "shared" : "private");
  if (p.around) parts.push(`${p.around} around`);
  return parts.join(" · ");
}

/** Render queued items for injection into the model's context. */
export function renderForModel(session: Session): string | undefined {
  const items = session.drainInject();
  const lines = items.map((i) => {
    const card = i.card ? ` [card ${i.card}]` : "";
    const id = i.id ? ` (id ${i.id})` : "";
    const label = i.kind === "note" ? "relevant activity" : i.kind;
    return `- ${label} from ${i.from}${card}${id}: ${i.text}`;
  });
  if (session.chatter) {
    for (const i of session.drawerItems(10)) if (i.level === "drawer") lines.push(`- [chatter, not addressed to you] ${i.from} ${i.kind}: ${i.text.slice(0, 200)}`);
  }
  if (!lines.length) return undefined;
  return `Trough messages (team coordination; a steer may change what you do next, but you decide whether it's relevant; reply with the trough tool, action=reply and the id):\n${lines.join("\n")}`;
}

export const HELP = `trough commands (human only):
  /trough share | unshare            share or retract this session
  /trough default-shared yes|no      default for new sessions
  /trough sharing                    show sharing state
  /trough catchup [who] [since]      e.g. /trough catchup dan 3d
  /trough chatter on|off             show background traffic in the transcript
  /trough drafts | approve <id> | veto <id>
  /trough review review|auto-after|auto
  /trough relevance off|refs|assisted
  /trough status`;

/** Human commands typed as `/trough ...` (intercepted by hooks, never sent to the model). */
export async function runCommand(session: Session, line: string): Promise<string> {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const ackText = (r: { text?: string } | undefined) => r?.text ?? "No answer from your steward (it may be starting up); try again shortly.";
  switch (cmd) {
    case "share":
    case "unshare": {
      const r = await session.control(cmd);
      if (r?.data && typeof r.data.shared === "boolean") session.shared = r.data.shared;
      session.hello();
      if (cmd === "unshare" && r?.data?.changed) {
        const n = session.purgeChannelHistory();
        return `${ackText(r)} Deleted ${n} of this session's lobby message(s) from the server's history.`;
      }
      return ackText(r);
    }
    case "default-shared": {
      const v = args[0]?.toLowerCase();
      if (v !== "yes" && v !== "no") return "Usage: /trough default-shared yes|no";
      return ackText(await session.control("default-shared", v === "yes"));
    }
    case "sharing":
      return ackText(await session.control("sharing"));
    case "catchup": {
      const who = args[0] && !/^\d+[mhdw]?$/.test(args[0]) ? args[0] : undefined;
      const since = args.find((a) => /^\d+[mhdw]?$/.test(a)) ?? "1d";
      parseDuration(since);
      if (!who) {
        const people = [...new Set(session.roster().map((r) => r.nick.split("|")[0]!))];
        if (!people.includes(session.principal)) people.push(session.principal);
        const answers = await Promise.all(people.map((p) => session.recall(p, { since })));
        return answers.map((a, i) => a?.text ?? `${people[i]}: no answer`).join("\n");
      }
      return (await session.recall(who, { since }))?.text ?? `No answer from ${who}|steward.`;
    }
    case "chatter":
      session.chatter = args[0] === "on";
      return `Chatter ${session.chatter ? "on: background traffic is copied into the transcript, marked" : "off"}.`;
    case "drafts": {
      const r = await session.control("drafts");
      const drafts = (r?.data?.drafts as { id: string; card: string; text: string }[] | undefined) ?? [];
      return drafts.length ? drafts.map((d) => `${d.id} on ${d.card}: ${d.text.slice(0, 160)}`).join("\n") : "No draft digests.";
    }
    case "approve":
    case "veto":
      return ackText(await session.control(cmd, args[0]));
    case "review":
    case "relevance":
      return ackText(await session.control(cmd, args[0]));
    case "status": {
      const roster = session.roster();
      return [
        `${session.nick} (${session.agent}${session.role ? `, ${session.role}` : ""}) - ${session.irc.isRegistered ? "connected" : "connecting"}, ${session.shared ? "shared" : "private"}`,
        `cards: ${[...session.cards].join(", ") || "none yet"}`,
        `around: ${roster.map((r) => r.nick).join(", ") || "nobody seen yet"}`,
      ].join("\n");
    }
    default:
      return HELP;
  }
}

async function handleLocal(session: Session, req: { op: string; line?: string; data?: Record<string, unknown> }): Promise<{ ok: boolean; text: string; inject?: string; data?: unknown }> {
  switch (req.op) {
    case "drain":
      return { ok: true, text: "", inject: renderForModel(session) };
    case "peek":
      // Non-destructive: for status lines and other indicators.
      return { ok: true, text: "", data: peek(session) };
    case "command":
      return { ok: true, text: await runCommand(session, req.line ?? "") };
    case "checkpoint": {
      const ack = await session.checkpoint(req.data ?? {});
      return { ok: true, text: ack ? `Filed on ${ack.data?.card}.` : "Queued in the WAL; your steward will get it when it's back.", data: ack?.data };
    }
    case "update": {
      const ack = await session.update(String(req.data?.text ?? ""), req.data?.card as string | undefined);
      return { ok: true, text: ack ? "Filed." : "Queued.", data: ack?.data };
    }
    case "drawer":
      return { ok: true, text: "", data: { roster: session.roster(), items: session.drawerItems(50) } };
    default:
      return { ok: false, text: `unknown op ${req.op}` };
  }
}
