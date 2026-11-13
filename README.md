# Antigravity Context Lite

English | [简体中文](README.zh-CN.md)

An ultra-lightweight real-time Context Window monitor built for Antigravity IDE, with zero external runtime dependencies.

> **Which mode should I use?**
> - **Antigravity 2.x (Standalone Desktop App)**: Use **Option 1 (CDP Mode, `scripts/`)**. Antigravity 2.x does not support `.vsix` extensions, and generates `DevToolsActivePort` automatically by default.
> - **Antigravity 1.x / VS Code**: Use **Option 2 (`.vsix` Extension)**.

### Inline Toolbar
![Inline statusbar preview](docs/preview-inline.png)

### Hover Details
![Hover tooltip preview](docs/preview-hover.png)

## Key Features
- **Native Inline Embedding (CDP Mode)**: Seamlessly mounts inside the chat composer footer right next to the model selector (`.agy-composer-footer`) with a transparent background and no border; automatically falls back to a floating bottom-right pill when the composer is unavailable.
- **Dynamic Model & Context Limit Resolution**: Queries the local `language_server` `GetUserStatus` endpoint on startup (and refreshes on unknown models) to resolve display names and infer context limits (`256k` default compaction threshold for Gemini, `200k` for Claude models, `128k` for GPT-OSS / 128k, `2M` for 2M models) without manual config updates.
- **Three-Tier Color Warnings & Tooltip Breakdown**: Uses native muted/emerald under `50%`, amber between `50%` and `80%`, and red at `≥ 80%`. Hovering reveals Prompt Cache, turn input, model output, and incremental token estimates.
- **Cross-Platform**: Unified support for Linux, Windows, and macOS (reads `DevToolsActivePort` automatically, with local listening-port scanning fallback on Windows).

## Project Structure
```text
antigravity-context-lite/
├── docs/
│   ├── preview-inline.png        # Inline toolbar preview
│   └── preview-hover.png         # Hover tooltip preview
├── src/
│   └── extension.ts              # VS Code extension source (status bar mode)
├── scripts/
│   ├── cdp-helpers.mjs           # Cross-platform process/CSRF/CDP target discovery
│   ├── inject-statusbar.mjs      # Live CDP injector (inline composer + fallback)
│   └── statusbar-daemon.mjs      # Background daemon (polls every 6s and re-injects)
├── LICENSE                       # MIT License
├── package.json
└── tsconfig.json
```

## Usage

### Option 1: Live CDP Inline Injection (For Antigravity 2.x, Recommended)
Requirements: Node.js `>= 20` (built-in `fetch` and `WebSocket`) and a running Antigravity 2.x instance (`DevToolsActivePort` is created automatically). You can either clone this repo or download `antigravity-context-lite-cdp-v1.0.0.zip` from [Releases](https://github.com/totoro-atelier/antigravity-context-lite/releases).

One-shot injection test:
```bash
node scripts/inject-statusbar.mjs
```

Background auto-injection daemon:
```bash
node scripts/statusbar-daemon.mjs
```

- **Linux (`systemd`)**: Create a service running `node /path/to/antigravity-context-lite/scripts/statusbar-daemon.mjs`.
- **Windows (hidden startup)**: Place a `.vbs` script in `shell:startup`:
  ```vbscript
  CreateObject("Wscript.Shell").Run "node ""C:\path\to\antigravity-context-lite\scripts\statusbar-daemon.mjs""", 0, False
  ```

### Option 2: VS Code / VSIX Extension (Native Status Bar)
```bash
npm install
npm run compile
npm run package
```
In Antigravity IDE / VS Code, run `Extensions: Install from VSIX...` and select the generated `.vsix` file (or download the pre-built `.vsix` from [Releases](https://github.com/totoro-atelier/antigravity-context-lite/releases)).

## CDP Mode vs. VSIX Extension
| Feature | CDP Inline Mode (`scripts/`) | VSIX Extension (`antigravity-context-lite.vsix`) |
|---|---|---|
| Display Location | Embedded inside chat composer (`.agy-composer-footer`), with floating fallback | Native bottom-right VS Code status bar |
| Hover Tooltip | Detailed token breakdown (Prompt Cache, turn input, model output) | Same detailed breakdown |
| Install Method | Run with Node.js `>= 20` (no IDE extension install needed) | Install `.vsix` in Extensions |

## Tested Environments
- **OS**: Ubuntu 24.04 LTS, Windows 11
- **IDE**: Antigravity IDE `2.31.2`
- **Runtime**: Node.js `>= 20` (verified on Node.js `24.x`)

## Troubleshooting
- **`DevToolsActivePort` not found**: Make sure Antigravity is running with remote debugging enabled (`DevToolsActivePort` exists under `~/.config/Antigravity/` on Linux, `%APPDATA%\Antigravity\` on Windows, or `~/Library/Application Support/Antigravity/` on macOS).
- **Status bar does not appear**: Verify `node -v` is `>= 20` (built-in `fetch` and `WebSocket` are required), and run `node scripts/inject-statusbar.mjs` once to inspect console output.

## Compatibility & Disclaimer
- This project reads `--csrf_token` from the local `language_server` process arguments to call local RPC endpoints (`GetUserStatus`, `GetAllCascadeTrajectories`, `GetCascadeTrajectorySteps`). CDP mode also relies on Antigravity frontend DOM selectors (such as `.agy-composer-footer`).
- These internal interfaces and DOM selectors are not official public APIs and may require adjustments across Antigravity IDE updates.

## License
[MIT](LICENSE)
