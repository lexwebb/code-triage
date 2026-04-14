/* eslint-disable no-restricted-globals */
self.addEventListener("push", (event) => {
  const payload = event.data?.json() ?? {};
  const { title = "Code Triage", body = "", icon = "/logo.png", data = {} } = payload;
  event.waitUntil(self.registration.showNotification(title, { body, icon, data }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    }),
  );
});
