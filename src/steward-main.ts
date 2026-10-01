#!/usr/bin/env node
// Steward server: hosts one Steward per principal, each on its own IRC connection as
// `<principal>|steward`, all logged in to the shared steward service account.
//
// Env:
//   TROUGH_IRC_HOST / _PORT / _TLS / _INSECURE   IRC server
//   TROUGH_STEWARD_PASSWORD                      password for the trough-steward account
//   TROUGH_STEWARD_REGISTER=1                    register that account if it doesn't exist (local/dev)
//   TROUGH_PRINCIPALS                            comma list, or "*" to start a steward for any
//                                                authenticated principal seen in #trough
//   TROUGH_DATA_DIR                              card store root (default ./.trough-data)
//   TROUGH_LLM_URL / _MODEL / _KEY               optional OpenAI-compatible endpoint
//   TROUGH_HTTP_PORT                             health endpoint (default 8080)

import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { IrcClient, type IrcOptions } from "./irc.ts";
import { llmFromEnv } from "./llm.ts";
import { Assembler, LOBBY, STEWARD_ACCOUNT, STEWARDS_CHANNEL, encodeEnvelope, isAuthentic, parseNick, stewardNick, type Received } from "./protocol.ts";
import { Steward } from "./steward.ts";
import { PrincipalStore } from "./store.ts";

const env = process.env;
const host = env.TROUGH_IRC_HOST || "127.0.0.1";
const port = Number(env.TROUGH_IRC_PORT || 6667);
const tls = env.TROUGH_IRC_TLS === "1" || env.TROUGH_IRC_TLS === "true";
const insecure = env.TROUGH_IRC_INSECURE === "1" || env.TROUGH_IRC_INSECURE === "true";
const password = env.TROUGH_STEWARD_PASSWORD || "";
const dataDir = env.TROUGH_DATA_DIR || "./.trough-data";
const allow = (env.TROUGH_PRINCIPALS || "*").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const debug = env.TROUGH_DEBUG === "1";
const llm = llmFromEnv();

if (!password) {
  console.error("TROUGH_STEWARD_PASSWORD is required");
  process.exit(1);
}

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

const base: Omit<IrcOptions, "nick"> = { host, port, tls, insecure, account: STEWARD_ACCOUNT, password, log: debug ? (l) => log(l) : undefined };
const stewards = new Map<string, { steward: Steward; client: IrcClient }>();

/** Make sure the steward service account exists (dev clusters with open registration). */
async function ensureAccount(): Promise<void> {
  const probe = new IrcClient({ ...base, nick: STEWARD_ACCOUNT, reconnectMs: 60_000 });
  probe.on("error", () => undefined); // connection refused etc. surface as the ready() timeout
  let saslFailed = false;
  probe.on("saslFailed", () => {
    saslFailed = true;
  });
  probe.connect();
  try {
    await probe.ready();
  } catch (e) {
    probe.close();
    throw e;
  }
  if (saslFailed) {
    if (env.TROUGH_STEWARD_REGISTER !== "1") throw new Error(`account ${STEWARD_ACCOUNT} doesn't exist or the password is wrong; set TROUGH_STEWARD_REGISTER=1 to create it`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("NickServ REGISTER timed out")), 10_000);
      probe.on("message", (m) => {
        if (m.command !== "NOTICE" || !/^NickServ!/i.test(m.prefix ?? "")) return;
        clearTimeout(t);
        const text = m.params.at(-1) ?? "";
        // An existing account with a different password is a config error, not something to paper over.
        if (/created/i.test(text)) resolve();
        else reject(new Error(`couldn't register ${STEWARD_ACCOUNT}: ${text} (wrong TROUGH_STEWARD_PASSWORD?)`));
      });
      probe.send(`PRIVMSG NickServ :REGISTER ${password}`);
    });
    log(`registered account ${STEWARD_ACCOUNT}`);
  }
  probe.close();
}

function startSteward(principal: string): void {
  if (stewards.has(principal)) return;
  const store = new PrincipalStore(dataDir, principal);
  const client = new IrcClient({ ...base, nick: stewardNick(principal), channels: [LOBBY, STEWARDS_CHANNEL] });
  const steward = new Steward(store, { send: (target, e) => encodeEnvelope(target, e).forEach((l) => client.send(l)) }, llm);
  const asm = new Assembler();
  client.on("message", (m) => {
    if (m.command === "QUIT" || m.command === "PART") return steward.onGone((m.prefix ?? "").split("!")[0] ?? "");
    const r = asm.push(m);
    if (r && !("plain" in r)) steward.handle(r as Received).catch((e) => log(`[${principal}] handler error`, e));
  });
  client.on("error", (e: Error) => log(`[${principal}] irc error: ${e.message}`));
  client.on("saslFailed", (why: string) => log(`[${principal}] SASL failed: ${why}`));
  client.on("registered", (nick: string) => log(`[${principal}] steward online as ${nick}`));
  client.connect();
  stewards.set(principal, { steward, client });
}

/** A watcher on #trough that starts stewards for principals we haven't seen yet. */
function startWatcher(): void {
  const client = new IrcClient({ ...base, nick: "trough-stewards", channels: [LOBBY] });
  const asm = new Assembler();
  client.on("message", (m) => {
    const r = asm.push(m);
    if (!r || "plain" in r || r.kind !== "hello") return;
    if (!isAuthentic(r.from, r.account)) return;
    const p = parseNick(r.from)!.principal;
    if (allow.includes("*") || allow.includes(p)) {
      if (!stewards.has(p)) {
        log(`starting steward for ${p} (first hello from ${r.from})`);
        startSteward(p);
      }
    }
  });
  client.on("error", (e: Error) => log(`[watcher] irc error: ${e.message}`));
  client.connect();
}

async function main(): Promise<void> {
  // Ergo may still be starting (same rollout); retry rather than crash-loop.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureAccount();
      break;
    } catch (e) {
      if (attempt >= 12 || (e as Error).message.includes("couldn't register")) throw e;
      log(`waiting for IRC (${(e as Error).message}); retry ${attempt}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const known = existsSync(dataDir) ? readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  for (const p of new Set([...known, ...allow.filter((a) => a !== "*")])) startSteward(p);
  startWatcher();
  setInterval(() => {
    for (const { steward } of stewards.values()) steward.tick();
  }, 60_000);
  createServer((req, res) => {
    const ok = [...stewards.values()].every((s) => s.client.isRegistered);
    res.writeHead(req.url === "/healthz" && !ok ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, stewards: [...stewards.keys()] }));
  }).listen(Number(env.TROUGH_HTTP_PORT || 8080));
  log(`trough steward server: irc ${host}:${port}${tls ? " (tls)" : ""}, data ${dataDir}, principals ${allow.join(",")}`);
}

const shutdown = () => {
  for (const { client } of stewards.values()) client.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
