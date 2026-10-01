// Client-side configuration: ~/.trough/config.json, overridable by TROUGH_* env vars.
// Written by `trough init` (onboarding).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClientConfig {
  host: string;
  port: number;
  tls: boolean;
  insecure: boolean;
  principal: string;
  password: string;
}

export function troughHome(): string {
  return process.env.TROUGH_HOME || join(homedir(), ".trough");
}

export function configPath(): string {
  return join(troughHome(), "config.json");
}

export function loadConfig(): ClientConfig | undefined {
  let file: Partial<ClientConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<ClientConfig>;
  } catch {
    // no config yet
  }
  const env = process.env;
  const cfg = {
    host: env.TROUGH_IRC_HOST || file.host || "",
    port: Number(env.TROUGH_IRC_PORT || file.port || 6667),
    tls: (env.TROUGH_IRC_TLS ?? String(file.tls ?? false)) === "true" || env.TROUGH_IRC_TLS === "1",
    insecure: (env.TROUGH_IRC_INSECURE ?? String(file.insecure ?? false)) === "true" || env.TROUGH_IRC_INSECURE === "1",
    principal: (env.TROUGH_PRINCIPAL || file.principal || "").toLowerCase(),
    password: env.TROUGH_PASSWORD || file.password || "",
  };
  return cfg.host && cfg.principal && cfg.password ? cfg : undefined;
}

export function saveConfig(cfg: ClientConfig): void {
  mkdirSync(troughHome(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

export const NOT_CONFIGURED = "trough isn't configured yet. Run `trough init` in a terminal (the human, not the agent) to pick a server, account and sharing default.";
