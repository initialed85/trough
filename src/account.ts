// Account registration for a principal: SASL check, else NickServ REGISTER.
// Works on servers with open registration (local/dev); production servers should close
// registration and have an admin create accounts.

import type { ClientConfig } from "./config.ts";
import { IrcClient } from "./irc.ts";

export async function register(cfg: ClientConfig): Promise<string> {
  const c = new IrcClient({ host: cfg.host, port: cfg.port, tls: cfg.tls, insecure: cfg.insecure, nick: cfg.principal, account: cfg.principal, password: cfg.password, reconnectMs: 60_000 });
  let saslOk = false;
  c.on("message", (m) => {
    if (m.command === "900") saslOk = true;
  });
  c.connect();
  await c.ready();
  if (saslOk) {
    c.close();
    return "Account already exists and the password works.";
  }
  const result = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve("NickServ didn't answer; registration may be closed on this server (ask an admin to create your account)."), 8_000);
    c.on("message", (m) => {
      const text = m.params.at(-1) ?? "";
      if (m.command === "NOTICE" && /NickServ/i.test(m.prefix ?? "")) {
        clearTimeout(t);
        resolve(text);
      }
    });
    c.send(`PRIVMSG NickServ :REGISTER ${cfg.password}`);
  });
  c.close();
  return result;
}
