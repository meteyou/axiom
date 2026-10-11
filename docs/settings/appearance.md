# Appearance

Branding of the web interface. The setting is instance-wide: it applies to every user, not just the admin who changes it.

**URL:** `/settings?tab=appearance`

## Logo

The logo shown in the sidebar, on the login page, as the assistant avatar in [Chat](../web-ui/chat) and as the browser tab icon (favicon).

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
