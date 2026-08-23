# OmniRoute OpenCode Plugin — Custom Build

Custom distribution of `@omniroute/opencode-plugin` (**v0.2.2-custom.1**) for the
[OmniRoute AI Gateway](https://github.com/diegosouzapw/OmniRoute).

**This fork's difference vs upstream:** warnings never print to the OpenCode TUI.
Everything at `warn`/`info`/`debug` level goes to a size-capped rotating log file;
only genuine `error` output (e.g. gateway unreachable after retries) still appears
on console. Also includes auto-combo catalog fixes and boot-stall retries.

---

## Requirements

| Tool              | Version                                       |
| ----------------- | --------------------------------------------- |
| Node.js           | >= 22.x                                       |
| npm               | >= 10                                         |
| git               | any                                           |
| OpenCode          | >= 1.14 recommended                           |
| OmniRoute Gateway | running somewhere reachable from this machine |

## 1. Clone and build

macOS / Linux:

```bash
git clone -b opencode-plugin-custom --depth 1 \
  https://github.com/adevwithpurpose/OmniRoute.git omniroute-plugin
cd omniroute-plugin
npm install
npm run build
```

Windows (PowerShell):

```powershell
git clone -b opencode-plugin-custom --depth 1 `
  https://github.com/adevwithpurpose/OmniRoute.git omniroute-plugin
cd omniroute-plugin
npm install
npm run build
```

Success check: `dist/index.js` exists.

## 2. Register the plugin in OpenCode config

Edit `~/.config/opencode/opencode.json`
(Windows: `%USERPROFILE%\.config\opencode\opencode.json`)
and add to the top-level `"plugin"` array — use an **absolute** path:

```json
{
  "plugin": [
    [
      "file:///ABSOLUTE/path/to/omniroute-plugin/dist/index.js",
      {
        "providerId": "omniroute",
        "baseURL": "http://GATEWAY-HOST:20128"
      }
    ]
  ]
}
```

- `providerId` — keep `omniroute` unless you intentionally run a second instance.
- `baseURL` — your OmniRoute gateway address (e.g. `http://127.0.0.1:20128` if local).
- If an official `@omniroute/opencode-plugin` entry already exists in `"plugin"`,
  remove it — do not load both.

## 3. Authentication

The plugin reads the API key from OpenCode's `auth.json`
(`~/.local/share/opencode/auth.json`, Windows:
`%USERPROFILE%\.local\share\opencode\auth.json`).
Add or merge an entry keyed exactly by `providerId`:

```json
{
  "omniroute": {
    "type": "api",
    "key": "YOUR_OMNIROUTE_API_KEY"
  }
}
```

Create the file if it does not exist. Get the key from the OmniRoute dashboard
(`Keys`) or `omniroute keys` on the gateway machine. Do not put the key anywhere else.

## 4. Verify

```bash
node -e "import('file:///ABSOLUTE/path/to/omniroute-plugin/dist/index.js').then(() => console.log('plugin loads OK'))"
```

Then restart OpenCode. Expected result:

- Models from the gateway appear under the `omniroute` provider.
- The TUI stays quiet. Warnings land in
  `~/.local/share/opencode/plugins/omniroute-plugin.log`
  (timestamped, rotated at 256 KB, one `.old` backup kept).

To temporarily mirror warnings back into the TUI while debugging:

```
OMNIROUTE_PLUGIN_LOG_CONSOLE=1
```

## Troubleshooting

| Symptom                                             | Check                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| No models listed                                    | `auth.json` entry present and keyed `omniroute`? Key valid?                               |
| `publishing stub provider entry` error once at boot | Gateway was unreachable ~35s; it self-heals on next sync. Check gateway health.           |
| Want full request-level detail                      | Set plugin option `"features": { "debugLog": true }` — writes JSONL next to the log file. |
| Plugin not loading                                  | Path must be absolute in `opencode.json`; run the `node -e import(...)` check above.      |

## Uninstall / rollback

Remove the plugin entry from `opencode.json` and delete the cloned folder.
Your auth and logs are untouched.
