import confetti from "canvas-confetti";

const colors = ["#22c55e", "#4ade80", "#86efac", "#38bdf8", "#c084fc"];

/** Full-width burst from the bottom center — runs after a successful fix apply. */
export function celebrateFixApplied(): void {
  const count = 200;
  const defaults = { origin: { y: 0.72 }, zIndex: 10000, colors };

  function fire(particleRatio: number, opts: confetti.Options) {
    void confetti({
      ...defaults,
      ...opts,
      particleCount: Math.floor(count * particleRatio),
    });
  }

  fire(0.25, { spread: 26, startVelocity: 55 });
  fire(0.2, { spread: 60 });
  fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
  fire(0.1, { spread: 120, startVelocity: 45, decay: 0.92, scalar: 1.2 });
  fire(0.1, { spread: 120, startVelocity: 25 });
}
