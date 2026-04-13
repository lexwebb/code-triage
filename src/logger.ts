import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const LOG_FILE = join(homedir(), ".code-triage", "debug.log");
const DEBUG = process.env["DEBUG"] === "true" || process.argv.includes("--debug");

function write(level: string, msg: string, ...args: unknown[]): void {
  const extra = args.length ? " " + args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ") : "";
  const line = `[${level}] ${msg}${extra}`;
  process.stderr.write(line + "\n");

  if (DEBUG) {
    try {
      mkdirSync(join(homedir(), ".code-triage"), { recursive: true });
      appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Ignore log file errors
    }
  }
}

export const log = {
  info: (msg: string, ...args: unknown[]) => write("INFO", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write("WARN", msg, ...args),
  error: (msg: string, ...args: unknown[]) => write("ERROR", msg, ...args),
  debug: (msg: string, ...args: unknown[]) => { if (DEBUG) write("DEBUG", msg, ...args); },
};
