import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CONFIG_DIR = join(homedir(), ".code-triage");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
  root: string;
  port: number;
  interval: number; // minutes
  ignoredBots?: string[]; // additional bot logins to ignore during polling
  accounts?: Array<{ name: string; token: string; orgs: string[] }>; // multi-account support
}

const DEFAULTS: Config = {
  root: "~/src",
  port: 3100,
  interval: 1,
};

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return { ...DEFAULTS };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}
