# App Install & Push Notifications

Send a message, lock your phone, and get a notification when the reply is ready. This page shows you how to install Axiom as an app and turn on push notifications for each of your devices.

## How it works

Axiom ships a small service worker (`/sw.js`). It does three things:

- **Push notifications.** When a chat turn you started in the web UI finishes (or fails) and none of your chat tabs is visible, the backend sends a Web Push message to every device you enabled. Tapping the notification opens Axiom on the chat.
- **Offline page.** When the server cannot be reached, the app shows a small "Axiom is offline" page instead of a browser error. It reloads by itself once the connection is back.
- **Asset cache.** Hashed build files under `/_nuxt/` are cached, so the app starts faster. HTML, API calls, WebSocket traffic and your data are never cached, so a new release shows up on the next reload.

A turn keeps running when you close the tab — the backend finishes it and stores the reply. The notification only tells you it is there.

### When you get a notification

| Situation when the reply finishes                         | Notification? |
|-----------------------------------------------------------|---------------|
| The chat is open and visible on any of your devices       | No            |
| The chat tab is in the background or the phone is locked  | Yes           |
| You closed the app or navigated to another Axiom page     | Yes           |
| You stopped the turn with **Stop** or started a new session | No          |

Visibility is reported by each open chat page. One visible chat on any device is enough to skip the notification, so you don't get pinged for a reply you are already reading.

Only chat turns you start from the web UI notify. Telegram messages already arrive in Telegram, and task results or heartbeat messages don't send push notifications.

## Requirements

- **HTTPS.** Browsers only allow service workers and push on secure origins. Put Axiom behind a reverse proxy with a valid certificate (Caddy, Traefik, nginx, Tailscale Serve, …). `http://localhost` works for testing on the same machine.
- **A browser with Web Push.** Chrome, Edge, Firefox and Samsung Internet on Android and desktop; Safari on macOS; Safari on iPhone and iPad from **iOS / iPadOS 16.4** — only as a Home Screen app (see below).
- **Outbound HTTPS from the server** to the push services (`fcm.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`).

## Install Axiom as an app

### iPhone and iPad

Push on iOS only works in the installed app, not in a Safari tab.

1. Open your Axiom URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Open Axiom from the new Home Screen icon and sign in again (the installed app has its own storage).
4. Enable notifications as described below — inside the installed app.

Until you do this, the Notifications settings tell you to add the app to the Home Screen.

::: info App icon and name
The web app manifest (app name, icons, standalone display) ships separately. Without it, iOS still installs the page, but with a screenshot icon and the page title.
:::

### Android

Chrome and other Android browsers deliver push in a normal tab, so installing is optional. To get an app icon: open the browser menu → **Add to Home screen** (or **Install app**).

### Desktop

Chrome and Edge offer **Install** in the address bar. Push also works in a normal tab as long as the browser is running.

## Enable notifications

Notifications are set up **per device**. Do this once on each phone, tablet or browser that should be notified.

1. Open **Settings → Notifications**.
2. Click **Enable on this device**. Your browser asks for permission — allow it.
3. Click **Send test**. The notification should arrive within a few seconds.

The **Your devices** list shows every device that receives your notifications, with the time of the last successful delivery. Remove a device there when you no longer use it. Logging out also removes the device you log out on, so the next person on a shared browser does not get your notifications.

Every user manages their own devices. Nobody — admins included — can see or remove another user's devices.

### Message preview

By default a notification reads **Axiom — Reply ready** (or **The reply failed**) and contains nothing from the conversation.

Turn on **Show message preview** to add the first 120 characters of the reply instead. The setting applies to all your devices.

::: warning Push services carry the message
Web Push payloads are end-to-end encrypted between your server and your device — the push service cannot read them. They still travel through the browser vendor's push service (Apple, Google, Mozilla or Microsoft), which sees that *a* notification was sent, when, and to which device. Keep the preview off if even encrypted reply text should not leave your server.
:::

## Troubleshooting

| Symptom                                                    | What to check |
|------------------------------------------------------------|---------------|
| "Push notifications need a secure connection"             | Open Axiom over `https://` (or `http://localhost`). |
| "Notifications only work in the Home Screen app" on iPhone | Add Axiom to the Home Screen and enable notifications inside the installed app. |
| "Notifications are blocked for this site"                  | You denied the permission once. Allow notifications for the site in the browser or system settings, then reload. |
| Test works on Android but iPhone gets nothing              | Apple rejects VAPID contacts it cannot verify. Set `VAPID_SUBJECT` to a real `mailto:` address or your public `https://` URL (see below). |
| A device disappeared from the list                         | The push service reported the subscription as expired (HTTP 404/410), e.g. after the app was removed or site data was cleared. Enable it again on that device. |
| Notifications stopped after changing the VAPID keys        | Old subscriptions belong to the old keys. Click **Enable on this device** again on every device. |

## Server configuration

Push works without any configuration. On first start the backend generates a VAPID key pair (the keys that identify your server to the push services) and stores it in `/data/config/vapid.json`.

| Variable            | Default                         | Description |
|---------------------|---------------------------------|-------------|
| `VAPID_PUBLIC_KEY`  | _(from `vapid.json`)_           | Use your own VAPID key pair instead of the generated one. Set together with `VAPID_PRIVATE_KEY`. |
| `VAPID_PRIVATE_KEY` | _(from `vapid.json`)_           | Private half of the key pair. Keep it secret. |
| `VAPID_SUBJECT`     | _(origin the device subscribed from)_ | Contact for the push services: a `mailto:` address or an `https://` URL. |

Without `VAPID_SUBJECT`, Axiom uses the `https://` address each device subscribed from — your public Axiom URL — which Apple accepts. You can also put a `"subject"` field into `vapid.json`.

::: warning Back up `vapid.json`
Every subscription is bound to the public key. If the key pair changes (file deleted, different env values), all devices have to enable notifications again.
:::

### Endpoints

All endpoints require a signed-in user and only touch that user's own devices.

| Method   | Path                              | Purpose |
|----------|-----------------------------------|---------|
| `GET`    | `/api/push/vapid-public-key`      | Public key the browser subscribes with. |
| `GET`    | `/api/push/subscriptions`         | Your devices and your preview setting. |
| `POST`   | `/api/push/subscriptions`         | Register this browser (`{ subscription, deviceLabel, locale }`, where `subscription` is `PushSubscription.toJSON()`). |
| `DELETE` | `/api/push/subscriptions/:id`     | Remove one of your devices. |
| `POST`   | `/api/push/test`                  | Send a test notification to all your devices; returns the result per device. |
| `PUT`    | `/api/push/preferences`           | `{ "showPreview": true \| false }`. |

Devices are stored in the `push_subscriptions` table of `/data/db/axiom.db`, one row per browser installation. Deleting a user deletes their devices.

The server only accepts and sends to subscriptions of the browser vendors' push services (Google `fcm.googleapis.com`, Mozilla `*.push.services.mozilla.com`, Apple `*.push.apple.com`, Microsoft `*.notify.windows.com`). Other endpoints are rejected, so a user cannot make the server send requests to arbitrary hosts. Each delivery attempt times out after 10 seconds.
