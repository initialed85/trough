import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLine } from "../src/irc.ts";
import { Assembler, encodeEnvelope, escapeTag, isAuthentic, parseDuration, parseNick, unescapeTag, type Received } from "../src/protocol.ts";

/** Pretend a server relayed our lines: add prefix + account tag, then parse. */
function relay(lines: string[], from = "ed|cc-1", account = "ed") {
  return lines.map((l) => {
    const withTags = l.startsWith("@") ? `@account=${account};${l.slice(1)}` : `@account=${account} ${l}`;
    const sp = withTags.indexOf(" ");
    return parseLine(`${withTags.slice(0, sp)} :${from}!u@h ${withTags.slice(sp + 1)}`);
  });
}

test("nicks parse and format", () => {
  assert.deepEqual(parseNick("ed|cc-3f2a"), { principal: "ed", handle: "cc-3f2a" });
  assert.equal(parseNick("ed"), undefined);
  assert.equal(parseNick("ed|a|b"), undefined);
});

test("authenticity: sessions need their principal's account, stewards the service account", () => {
  assert.ok(isAuthentic("ed|cc-1", "ed"));
  assert.ok(!isAuthentic("ed|cc-1", "dan"));
  assert.ok(!isAuthentic("ed|cc-1", undefined));
  assert.ok(isAuthentic("ed|steward", "trough-steward"));
  assert.ok(!isAuthentic("ed|steward", "ed"));
});

test("tag escaping round-trips", () => {
  const v = "a b;c\\d\r\ne";
  assert.equal(unescapeTag(escapeTag(v)), v);
});

test("text-only envelope", () => {
  const asm = new Assembler();
  const [m] = relay(encodeEnvelope("#trough", { kind: "update", id: "x1", text: "hello\nworld" }));
  const r = asm.push(m!) as Received;
  assert.equal(r.kind, "update");
  assert.equal(r.text, "hello / world");
  assert.equal(r.account, "ed");
});

test("large payload chunks across TAGMSGs and reassembles with its text", () => {
  const data = { blob: "x".repeat(9000), nested: { n: 1 } };
  const lines = encodeEnvelope("ed|steward", { kind: "checkpoint", id: "big", data, text: "summary" });
  assert.ok(lines.length > 3);
  assert.ok(lines.every((l) => Buffer.byteLength(l) < 4000));
  const asm = new Assembler();
  const results = relay(lines).map((m) => asm.push(m));
  assert.deepEqual(results.slice(0, -1), new Array(lines.length - 1).fill(undefined));
  const r = results.at(-1) as Received;
  assert.deepEqual(r.data, data);
  assert.equal(r.text, "summary");
});

test("plain chat comes through as plain", () => {
  const asm = new Assembler();
  const r = asm.push(parseLine(":dan!u@h PRIVMSG #trough :anyone around?"));
  assert.ok(r && "plain" in r && r.text === "anyone around?");
});

test("durations", () => {
  assert.equal(parseDuration("3d"), 3 * 86_400_000);
  assert.equal(parseDuration("12h"), 12 * 3600_000);
});
