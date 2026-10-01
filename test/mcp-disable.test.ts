// TROUGH_DISABLE=1 keeps automation (e.g. a PR-review bot inheriting a global Codex MCP
// config) off the trough. Spawns the real MCP server over stdio with a valid config and
// checks it never connects; no IRC server needed.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("TROUGH_DISABLE=1 registers the tool but never joins", async () => {
  const home = mkdtempSync(join(tmpdir(), "trough-disable-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 1, tls: false, insecure: false, principal: "ed", password: "x" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/mcp.ts"], env: { ...env, TROUGH_HOME: home, TROUGH_DISABLE: "1" } });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["trough"]);
    const res = (await client.callTool({ name: "trough", arguments: { action: "status" } })) as { content: { text: string }[] };
    assert.match(res.content[0]!.text, /disabled/);
    // A connected session would have registered a local socket.
    let run: string[] = [];
    try {
      run = readdirSync(join(home, "run"));
    } catch {
      // no run dir at all: good
    }
    assert.deepEqual(run, []);
  } finally {
    await client.close();
  }
});
