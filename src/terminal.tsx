import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import readline from "readline";

type HotkeyHandler = () => void | Promise<void>;

interface HotkeyBinding {
  key: string;
  label: string;
  handler: HotkeyHandler;
}

let hotkeys: HotkeyBinding[] = [];
let statusMessage = "";
let nextPollTime: number | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let processing = false;
let triggerUpdate: (() => void) | null = null;
let inkInstance: ReturnType<typeof render> | null = null;

function triggerRerender() {
  triggerUpdate?.();
}

export function registerHotkeys(bindings: HotkeyBinding[]): void {
  hotkeys = bindings;
}

export function setStatus(message: string): void {
  statusMessage = message;
  triggerRerender();
}

export function setProcessing(value: boolean): void {
  processing = value;
  triggerRerender();
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
  triggerRerender();
}

function startCountdown(): void {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    triggerRerender();
  }, 1000);
}

function getCountdownStr(): string {
  if (!nextPollTime) return "";
  const remaining = Math.max(0, nextPollTime - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function StatusBar() {
  const [, setTick] = useState(0);
  const { exit } = useApp();

  useEffect(() => {
    triggerUpdate = () => setTick((t) => t + 1);
    return () => { triggerUpdate = null; };
  }, []);

  useInput((input, key) => {
    if (processing) return;

    if (key.ctrl && input === "c") {
      const quitBinding = hotkeys.find((h) => h.key === "q");
      if (quitBinding) {
        quitBinding.handler();
      } else {
        exit();
      }
      return;
    }

    const binding = hotkeys.find((h) => h.key === input);
    if (binding) {
      binding.handler();
    }
  });

  const countdown = getCountdownStr();
  const cols = process.stdout.columns || 80;

  return (
    <Box flexDirection="column" width={cols}>
      <Box>
        <Text wrap="wrap">
          {"  "}{statusMessage}
          {countdown ? <Text dimColor>{"  "}Next poll in {countdown}</Text> : null}
        </Text>
      </Box>
      <Box flexWrap="wrap" paddingLeft={2}>
        {hotkeys.map((h) => (
          <Box key={h.key} marginRight={2}>
            <Text><Text bold>[{h.key}]</Text> {h.label}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

export function enableRawMode(): void {
  if (!process.stdin.isTTY) return;
  inkInstance = render(<StatusBar />);
}

export function disableRawMode(): void {
  // ink handles raw mode internally
}

export function prompt(question: string): Promise<string> {
  // Unmount ink for readline prompt, re-mount after
  if (inkInstance) {
    inkInstance.unmount();
    inkInstance = null;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      // Re-mount ink
      inkInstance = render(<StatusBar />);
      resolve(answer.trim().toLowerCase());
    });
  });
}

export function cleanup(): void {
  clearCountdown();
  if (inkInstance) {
    inkInstance.unmount();
    inkInstance = null;
  }
}
