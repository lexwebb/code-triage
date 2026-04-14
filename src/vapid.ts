import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import webpush from "web-push";
import { getStateDir } from "./db/client.js";

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;

function vapidPath(): string {
  return join(getStateDir(), "vapid.json");
}

export function getVapidKeys(): VapidKeys {
  if (cached) return cached;

  const path = vapidPath();
  if (existsSync(path)) {
    cached = JSON.parse(readFileSync(path, "utf-8")) as VapidKeys;
    return cached;
  }

  const keys = webpush.generateVAPIDKeys();
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  writeFileSync(path, JSON.stringify(cached, null, 2));
  return cached;
}

export function initVapid(): void {
  const keys = getVapidKeys();
  webpush.setVapidDetails("mailto:code-triage@localhost", keys.publicKey, keys.privateKey);
}
