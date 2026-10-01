#!/usr/bin/env node
// Smoke-test a deployed trough (Ergo + steward server) with two throwaway principals.
//   node scripts/smoke.ts [host:port]     default 127.0.0.1:6667 (the local overlay)
// Needs open registration (the local overlay has it). Exits non-zero on failure.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TROUGH_HOME = mkdtempSync(join(tmpdir(), "trough-smoke-"));
const { register } = await import("../src/account.ts");
const { Session } = await import("../src/session.ts");

const [host, port] = (process.argv[2] ?? "127.0.0.1:6667").split(":");
const tag = randomBytes(2).toString("hex");
const cfg = (p: string) => ({ host: host!, port: Number(port), tls: false, insecure: false, principal: p, password: `smoke-${p}` });
const check = (ok: unknown, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exit(1);
};

async function online(p: string, agent: string) {
  console.log(`${p}: ${await register(cfg(p))}`);
  const s = new Session({ config: cfg(p), agent });
  const ready = new Promise((r) => s.once("steward", r));
  s.start();
  await Promise.race([ready, new Promise((_, rej) => setTimeout(() => rej(new Error(`${p}: no ack from ${p}|steward within 30s`)), 30_000))]);
  return s;
}

const a = await online(`smokea${tag}`, "claude-code");
const b = await online(`smokeb${tag}`, "codex");
await a.control("default-shared", true);
await a.control("share");
await a.control("review", "auto");
const ack = await a.checkpoint({ title: `Smoke card ${tag}`, digest: "smoke test digest", refs: [{ type: "ticket", value: `SMOKE-${parseInt(tag, 16)}` }] });
check(typeof ack?.data?.card === "string", `checkpoint filed on ${ack?.data?.card}`);
const recall = await b.recall(a.principal, { text: `smoke card ${tag}` });
check((recall?.data?.cards as unknown[] | undefined)?.length === 1, "coworker recall finds the card");
const catchup = await b.recall(a.principal, { since: "1h" });
check(catchup?.text?.includes(`Smoke card ${tag}`), "catchup lists it");
await a.control("unshare");
const hidden = await b.recall(a.principal, { text: `smoke card ${tag}` });
check(hidden?.text?.includes("Not in anything"), "unshare hides it");
a.stop();
b.stop();
process.exit(0);
