# Appearance

Branding of the web interface. The setting is instance-wide: it applies to every user, not just the admin who changes it.

**URL:** `/settings?tab=appearance`

## Logo

The logo shown in the sidebar, on the login page, as the assistant avatar in [Chat](../web-ui/chat), as the browser tab icon (favicon) and as the home-screen icon when you install Axiom as an app.

| Value     | Look                                                       |
|-----------|------------------------------------------------------------|
| `prism`   | White three-faceted prism on a green tile. **Default.**    |
| `raccoon` | Raccoon face on a navy tile.                               |
| `robot`   | Robot head on a green tile.                                |

Pick one of the three previews and press **Save settings**. The new logo appears immediately for you and on the next page load for everyone else. A missing or unknown value falls back to `prism`.

```json
{ "appearance": { "logo": "prism" } }
```

The login page has to show the logo before anyone is signed in, so the current value is readable without authentication via `GET /api/settings/appearance` (returns `{ "logo": "prism" }`). Changing it still requires an admin.

::: tip Browser support for the favicon
The tab icon follows the selected logo in browsers that support SVG favicons (Chrome, Edge, Firefox). Browsers that only use `favicon.ico` keep showing the default prism icon.
:::

## Installed app icon

You can add Axiom to your home screen (Android, iOS) or install it as a desktop app (Chrome, Edge). The icon follows the selected logo:

- The web app manifest is built from the current setting and served without authentication at `GET /site.webmanifest`. Its icons point to the PNGs of the selected logo, including a maskable icon for Android's adaptive icon shapes.
- iOS takes the `apple-touch-icon` of the page, which switches together with the favicon.

The icon is copied when you install the app. iOS never refreshes the icon of an installed app, and Android only picks up a new one eventually. After changing the logo, remove the app from your home screen and add it again.
