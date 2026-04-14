import notifier from "node-notifier";

/**
 * Desktop toast via node-notifier — used as fallback when no web push subscriptions exist.
 */
export function sendNotification(title: string, message: string): void {
  notifier.notify(
    { title, message },
    (err) => {
      if (err) {
        console.error("Desktop notification failed:", err.message);
      }
    },
  );
}
