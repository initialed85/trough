// Session behaviour that integrations depend on, without an IRC server.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Received } from "../src/protocol.ts";
import { Session, type Item } from "../src/session.ts";

process.env.TROUGH_HOME = mkdtempSync(join(tmpdir(), "trough-session-"));

function session(): Session {
  return new Session({ config: { host: "127.0.0.1", port: 1, tls: false, insecure: false, principal: "ed", password: "x" }, agent: "pi", handle: "pi-test" });
}

function deliver(s: Session, msg: Partial<Received>): void {
  // onReceived is private; this is the seam the IRC client feeds.
  (s as unknown as { onReceived(r: Received): void }).onReceived({ kind: "steer", id: "m1", from: "dan|cc-1", account: "dan", target: s.nick, time: new Date().toISOString(), ...msg } as Received);
}

test('emits "inject" when a message for the model arrives (Pi wakes on this)', () => {
  const s = session();
  const seen: Item[] = [];
  s.on("inject", (i: Item) => seen.push(i));
  deliver(s, { text: "hold off on optimize_size.py" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.kind, "steer");
  assert.equal(s.drainInject().length, 1, "still queued for hook-based integrations");
});

test("drawer-level traffic does not emit inject", () => {
  const s = session();
  let n = 0;
  s.on("inject", () => n++);
  deliver(s, { kind: "hello", target: "#trough", data: { agent: "codex" } });
  assert.equal(n, 0);
  assert.equal(s.drawerItems().length, 1);
});

test("roster is seeded from NAMES and follows joins/quits, ignoring stewards", () => {
  const s = session();
  const presence = (command: string, from: string, params: string[]) => (s as unknown as { trackPresence(c: string, f: string, p: string[]): void }).trackPresence(command, from, params);
  presence("353", "", [s.nick, "=", "#trough", `${s.nick} @ed|steward ed|cx-1 dan|cc-2 trough-stewards`]);
  assert.deepEqual(s.roster().map((r) => r.nick).sort(), ["dan|cc-2", "ed|cx-1"]);
  presence("JOIN", "ed|pi-9", ["#trough"]);
  presence("QUIT", "dan|cc-2", ["bye"]);
  assert.deepEqual(s.roster().map((r) => r.nick).sort(), ["ed|cx-1", "ed|pi-9"]);
});

test("a direct send to a nick the server says is gone is re-routed to that principal's steward", () => {
  const s = session();
  const lines: string[] = [];
  (s.irc as unknown as { send(l: string): void }).send = (l: string) => lines.push(l);
  s.steer("dan|cc-gone", "are you there?");
  lines.length = 0;
  s.irc.emit("message", { tags: {}, command: "401", params: [s.nick, "dan|cc-gone", "No such nick"] });
  assert.ok(lines.some((l) => l.includes("dan|steward")), lines.join("\n"));
  s.irc.emit("message", { tags: {}, command: "401", params: [s.nick, "dan|cc-gone", "No such nick"] });
  assert.equal(lines.filter((l) => l.includes("PRIVMSG dan|steward")).length, 1, "re-routed once");
});

test("🐈 ends an exchange: never injected, never answered; long threads stop reaching the model", () => {
  const s = session();
  const lines: string[] = [];
  (s.irc as unknown as { send(l: string): void }).send = (l: string) => lines.push(l);
  deliver(s, { kind: "reply", id: "c1", text: " 🐈 " });
  assert.equal(s.drainInject().length, 0);
  assert.match(s.reply("c1", "you're welcome!"), /don't reply/);
  assert.equal(lines.length, 0);
  deliver(s, { kind: "reply", id: "d1", text: "and another thing", data: { depth: 6 } });
  assert.equal(s.drainInject().length, 0, "depth 6 goes to the drawer");
  deliver(s, { kind: "ask", id: "q1", text: "quick one?", data: { depth: 2 } });
  assert.equal(s.drainInject().length, 1);
  s.reply("q1", "sure");
  assert.ok(lines.some((l) => l.includes("PRIVMSG dan|cc-1")));
});
