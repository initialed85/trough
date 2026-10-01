// A deliberately small IRCv3 client: CAP negotiation, SASL PLAIN, tags, reconnect.
// No IRC library dependency so the whole transport is readable in one file.

import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { unescapeTag, type IrcMessage } from "./protocol.ts";

export interface IrcOptions {
  host: string;
  port: number;
  tls?: boolean;
  /** Accept self-signed certificates (local clusters). */
  insecure?: boolean;
  nick: string;
  account?: string;
  password?: string;
  channels?: string[];
  reconnectMs?: number;
  log?: (line: string) => void;
}

const WANTED_CAPS = ["message-tags", "account-tag", "server-time", "sasl", "echo-message"];

export function parseLine(line: string): IrcMessage {
  let rest = line;
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    for (const pair of rest.slice(1, sp).split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) tags[pair] = "";
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(sp + 1).trimStart();
  }
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1).trimStart();
  }
  const params: string[] = [];
  const trailingAt = rest.indexOf(" :");
  let head = rest;
  let trailing: string | undefined;
  if (trailingAt >= 0) {
    head = rest.slice(0, trailingAt);
    trailing = rest.slice(trailingAt + 2);
  }
  const words = head.split(" ").filter(Boolean);
  const command = (words.shift() ?? "").toUpperCase();
  params.push(...words);
  if (trailing !== undefined) params.push(trailing);
  return { tags, prefix, command, params };
}

/**
 * Events: "registered" (nick), "message" (IrcMessage), "saslFailed" (reason), "close",
 * "error" (socket Error; only emitted when someone listens).
 * `send` queues while disconnected and flushes on registration.
 */
export class IrcClient extends EventEmitter {
  readonly opts: IrcOptions;
  nick: string;
  private socket?: Socket;
  private buffer = "";
  private registered = false;
  private queue: string[] = [];
  private channels: Set<string>;
  private stopped = false;
  private acked = new Set<string>();
  private offered = new Set<string>();

  constructor(opts: IrcOptions) {
    super();
    this.opts = opts;
    this.nick = opts.nick;
    this.channels = new Set(opts.channels ?? []);
  }

  get isRegistered(): boolean {
    return this.registered;
  }

  hasCap(cap: string): boolean {
    return this.acked.has(cap);
  }

  connect(): void {
    this.stopped = false;
    const { host, port } = this.opts;
    const onConnect = () => this.handshake();
    this.socket = this.opts.tls
      ? tlsConnect({ host, port, servername: host, rejectUnauthorized: !this.opts.insecure }, onConnect)
      : createConnection({ host, port }, onConnect);
    this.socket.setEncoding("utf8");
    this.socket.setKeepAlive(true, 30_000);
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (err) => {
      if (this.listenerCount("error")) this.emit("error", err);
    });
    this.socket.on("close", () => this.onClose());
  }

  /** Resolves once registered (001), rejects after `timeoutMs`. */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.registered) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`IRC registration timed out (${this.opts.host}:${this.opts.port})`)), timeoutMs);
      this.once("registered", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  close(): void {
    this.stopped = true;
    if (this.registered) this.raw("QUIT :bye");
    this.socket?.end();
    this.socket?.destroy();
  }

  join(channel: string): void {
    this.channels.add(channel);
    if (this.registered) this.raw(`JOIN ${channel}`);
  }

  part(channel: string): void {
    this.channels.delete(channel);
    if (this.registered) this.raw(`PART ${channel}`);
  }

  /** Send a raw line once registered (queued until then). */
  send(line: string): void {
    if (this.registered) this.raw(line);
    else this.queue.push(line);
  }

  private raw(line: string): void {
    this.opts.log?.(`> ${line.slice(0, 200)}`);
    this.socket?.write(`${line}\r\n`);
  }

  private handshake(): void {
    this.registered = false;
    this.acked.clear();
    this.offered.clear();
    this.raw("CAP LS 302");
    this.raw(`NICK ${this.nick}`);
    this.raw(`USER trough 0 * :trough ${this.nick}`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    this.opts.log?.(`< ${line.slice(0, 200)}`);
    const msg = parseLine(line);
    switch (msg.command) {
      case "PING":
        this.raw(`PONG :${msg.params.at(-1) ?? ""}`);
        return;
      case "CAP":
        return this.onCap(msg);
      case "AUTHENTICATE":
        if (msg.params[0] === "+") {
          const blob = Buffer.from(`\0${this.opts.account}\0${this.opts.password}`).toString("base64");
          this.raw(`AUTHENTICATE ${blob}`);
        }
        return;
      case "903": // SASL success
        this.raw("CAP END");
        return;
      case "902":
      case "904":
      case "905":
      case "906":
      case "908":
        // Not "error": an unhandled error event would throw and stall the handshake.
        this.emit("saslFailed", msg.params.at(-1) ?? "");
        this.raw("CAP END");
        return;
      case "001":
        this.registered = true;
        this.nick = msg.params[0] ?? this.nick;
        for (const ch of this.channels) this.raw(`JOIN ${ch}`);
        for (const l of this.queue.splice(0)) this.raw(l);
        this.emit("registered", this.nick);
        return;
      case "433": // nick in use: add a suffix and retry
        this.nick = `${this.opts.nick.slice(0, 28)}-${Math.floor(Math.random() * 100)}`;
        this.raw(`NICK ${this.nick}`);
        return;
      default:
        this.emit("message", msg);
    }
  }

  private onCap(msg: IrcMessage): void {
    const sub = msg.params[1];
    if (sub === "LS") {
      // Multi-line LS has "*" before the trailing list; collect it all, then REQ once.
      for (const c of (msg.params.at(-1) ?? "").split(" ")) if (c) this.offered.add(c.split("=")[0]!);
      if (msg.params[2] === "*") return;
      const want = WANTED_CAPS.filter((c) => this.offered.has(c) && (c !== "sasl" || this.opts.password));
      if (want.length) this.raw(`CAP REQ :${want.join(" ")}`);
      else this.raw("CAP END");
    } else if (sub === "ACK") {
      for (const c of (msg.params.at(-1) ?? "").split(" ")) if (c) this.acked.add(c);
      if (this.acked.has("sasl") && this.opts.password) this.raw("AUTHENTICATE PLAIN");
      else this.raw("CAP END");
    } else if (sub === "NAK") {
      this.raw("CAP END");
    }
  }

  private onClose(): void {
    this.registered = false;
    this.emit("close");
    if (this.stopped) return;
    setTimeout(() => {
      if (!this.stopped) this.connect();
    }, this.opts.reconnectMs ?? 2_000);
  }
}
