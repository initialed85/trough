// End-to-end against a real Ergo: steward server + two principals' sessions.
// Needs an Ergo reachable at TROUGH_TEST_IRC (default 127.0.0.1:16667) with open
// registration; `scripts/test-ergo.sh up` starts one in Docker.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { register } from "../../src/account.ts";
import type { ClientConfig } from "../../src/config.ts";
import { callLocal, serveSession } from "../../src/local.ts";
import { Session } from "../../src/session.ts";

const [host, port] = (process.env.TROUGH_TEST_IRC ?? "127.0.0.1:16667").split(":");
const suffix = randomBytes(2).toString("hex");
const ed = `ed${suffix}`;
const dan = `dan${suffix}`;
const home = mkdtempSync(join(tmpdir(), "trough-e2e-"));
process.env.TROUGH_HOME = home;

let steward: ChildProcess;
const sessions: Session[] = [];
const cfg = (principal: string): ClientConfig => ({ host: host!, port: Number(port), tls: false, insecure: false, principal, password: `pw-${principal}-${suffix}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | Promise<T | undefined>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out waiting");
}

async function online(principal: string, agent: string): Promise<Session> {
  const s = new Session({ config: cfg(principal), agent });
  sessions.push(s);
  const ready = new Promise((r) => s.once("steward", r));
  s.start();
  await ready;
  return s;
}

before(async () => {
  steward = spawn(process.execPath, ["src/steward-main.ts"], {
    env: { ...process.env, TROUGH_IRC_HOST: host, TROUGH_IRC_PORT: port, TROUGH_STEWARD_PASSWORD: process.env.TROUGH_TEST_STEWARD_PASSWORD ?? "trough-test-steward", TROUGH_STEWARD_REGISTER: "1", TROUGH_DATA_DIR: join(home, "data"), TROUGH_HTTP_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  steward.stderr!.on("data", (d) => process.stderr.write(`[steward] ${d}`));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("steward server didn't start")), 15_000);
    steward.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("trough steward server")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  for (const p of [ed, dan]) await register(cfg(p));
});

after(() => {
  for (const s of sessions) s.stop();
  steward?.kill();
});

test("full flow: checkpoint, recall, ask/forward/reply, catchup, unshare, hook bridge", { timeout: 60_000 }, async () => {
  const a = await online(ed, "claude-code");
  const b = await online(dan, "codex");
  assert.equal(a.defaultShared, null, "onboarding not done yet");

  assert.match((await a.control("default-shared", true))?.text ?? "", /start shared/);
  assert.match((await a.control("share"))?.text ?? "", /now shared/);
  a.shared = true;
  await a.control("review", "auto");

  const ack = await a.checkpoint({ title: "ECW black collar", digest: "ECW branch omits nearblack -color 0,0,0, so flyovers keep a black collar.", refs: [{ type: "ticket", value: "TR-99999" }], recipes: [{ command: "gdalinfo x.ecw", purpose: "inspect the ECW nodata" }] });
  const card = ack?.data?.card as string;
  assert.ok(card?.startsWith("c-"));

  const recall = await b.recall(ed, { text: "ECW black collar" });
  assert.equal((recall?.data?.cards as { id: string }[])[0]?.id, card);

  // dan asks ed's steward; ed's live session on the card gets it and answers dan directly.
  const fwd = await b.ask(ed, "why do the ECW flyovers have a black collar?");
  assert.match(fwd?.text ?? "", /Passed to/);
  const injected = await until(() => a.drainInject().find((i) => i.kind === "ask"));
  a.reply(injected.id!, "nearblack runs without -color 0,0,0 on the ECW path");
  const answer = await until(() => b.drainInject().find((i) => i.kind === "reply"));
  assert.match(answer.text, /nearblack/);

  const catchup = await b.recall(ed, { since: "1d" });
  assert.match(catchup?.text ?? "", /ECW black collar/);

  // Hook bridge: a queued inject-level message is drained over the local socket.
  const stop = serveSession(a);
  b.steer(a.nick, "hold off, I'm changing optimize_size.py");
  const sock = join(home, "run", `${a.nick.replace("|", "_")}.session.sock`);
  const drained = await until(async () => (await callLocal(sock, { op: "drain" })).inject);
  assert.match(drained, /optimize_size/);
  assert.match((await callLocal(sock, { op: "command", line: "sharing" })).text, /shared/);
  stop();

  assert.match((await a.control("unshare"))?.text ?? "", /now private/);
  const hidden = await b.recall(ed, { text: "ECW black collar" });
  assert.match(hidden?.text ?? "", /Not in anything/);
});
