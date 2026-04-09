import readline from "readline";

// ANSI escape codes
const ESC = "\x1b";
const SAVE_CURSOR = `${ESC}[s`;
const RESTORE_CURSOR = `${ESC}[u`;
const CLEAR_LINE = `${ESC}[2K`;
const MOVE_TO_COL_0 = `\r`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;

type HotkeyHandler = () => void | Promise<void>;

interface HotkeyBinding {
  key: string;
  label: string;
  handler: HotkeyHandler;
}

let rawModeActive = false;
let hotkeys: HotkeyBinding[] = [];
let footerLines = 2; // status line + hotkey bar
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let nextPollTime: number | null = null;
let statusMessage = "";
let keypressHandler: ((str: string, key: readline.Key) => void) | null = null;
let processing = false;

export function setProcessing(value: boolean): void {
  processing = value;
  if (value) {
    hideFooter();
    disableRawMode();
  } else {
    enableRawMode();
    renderFooter();
  }
}

export function registerHotkeys(bindings: HotkeyBinding[]): void {
  hotkeys = bindings;
}

export function enableRawMode(): void {
  if (rawModeActive || !process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  keypressHandler = (_str: string, key: readline.Key) => {
    if (processing) return;

    // Ctrl+C always works
    if (key.ctrl && key.name === "c") {
      const quitBinding = hotkeys.find((h) => h.key === "q");
      if (quitBinding) {
        quitBinding.handler();
      } else {
        process.exit(0);
      }
      return;
    }

    const binding = hotkeys.find((h) => h.key === key.name);
    if (binding) {
      hideFooter();
      binding.handler();
    }
  };

  process.stdin.on("keypress", keypressHandler);
  rawModeActive = true;
}

export function disableRawMode(): void {
  if (!rawModeActive || !process.stdin.isTTY) return;

  if (keypressHandler) {
    process.stdin.removeListener("keypress", keypressHandler);
    keypressHandler = null;
  }

  process.stdin.setRawMode(false);
  process.stdin.pause();
  rawModeActive = false;
}

export function prompt(question: string): Promise<string> {
  // Temporarily disable raw mode for readline prompts
  const wasRaw = rawModeActive;
  if (wasRaw) disableRawMode();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      if (wasRaw) enableRawMode();
      resolve(answer.trim().toLowerCase());
    });
  });
}

export function setNextPollTime(ms: number): void {
  nextPollTime = Date.now() + ms;
  startCountdown();
}

export function clearCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  nextPollTime = null;
}

function startCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    if (!processing) renderFooter();
  }, 1000);
}

export function setStatus(message: string): void {
  statusMessage = message;
  if (!processing) renderFooter();
}

function getCountdownStr(): string {
  if (!nextPollTime) return "";
  const remaining = Math.max(0, nextPollTime - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `Next poll in ${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function renderFooter(): void {
  if (processing || !process.stdout.isTTY) return;

  const countdown = getCountdownStr();
  const statusLine = statusMessage + (countdown ? `  ${DIM}${countdown}${RESET}` : "");
  const hotkeyLine = hotkeys
    .map((h) => `${BOLD}[${h.key}]${RESET} ${h.label}`)
    .join("   ");

  // Save cursor, move to bottom area, render, restore
  const rows = process.stdout.rows || 24;
  process.stdout.write(SAVE_CURSOR);
  // Status line
  process.stdout.write(`${ESC}[${rows - 1};1H${CLEAR_LINE}  ${statusLine}`);
  // Hotkey bar
  process.stdout.write(`${ESC}[${rows};1H${CLEAR_LINE}  ${hotkeyLine}`);
  process.stdout.write(RESTORE_CURSOR);
}

function hideFooter(): void {
  if (!process.stdout.isTTY) return;
  const rows = process.stdout.rows || 24;
  process.stdout.write(SAVE_CURSOR);
  process.stdout.write(`${ESC}[${rows - 1};1H${CLEAR_LINE}`);
  process.stdout.write(`${ESC}[${rows};1H${CLEAR_LINE}`);
  process.stdout.write(RESTORE_CURSOR);
}

/** Write a log line above the footer */
export function log(message: string): void {
  if (processing || !process.stdout.isTTY) {
    console.log(message);
    return;
  }

  // Move to just above the footer, print, then re-render footer
  const rows = process.stdout.rows || 24;
  // Scroll content up if needed, write at the line above footer
  process.stdout.write(`${ESC}[${rows - footerLines};1H`);
  process.stdout.write(`${CLEAR_LINE}${message}\n`);
  renderFooter();
}

export function cleanup(): void {
  clearCountdown();
  hideFooter();
  disableRawMode();
}
