<div align="center">

<img src="src-tauri/icons/icon.png" width="80" alt="Bi-Code" />

# Bi-Code

A small, fast desktop code editor — VS Code-like, built with [Tauri](https://tauri.app).

Windows · macOS · Linux (x86_64 and ARM64)

</div>

---

## Features

- **Editor** — tree-sitter syntax highlighting, autocomplete, multi-cursor,
  column selection, regex find & replace, bracket matching.
- **Explorer** — folder tree with Git status colors, indent guides, drag-to-reorder
  tabs, breadcrumbs, and built-in image / SVG preview.
- **Themes** — built-in light/dark/high-contrast, plus any VS Code theme from
  [Open VSX](https://open-vsx.org).
- **Git** — stage, commit, push/pull, and clone, against GitHub/GitLab/custom remotes.
- **Run & Debug** — Node.js (breakpoints, stepping, variables), PHP and Web.
- **Terminal** — integrated, with tabs, split, and maximize.
- **Live Server** — preview sites (including PHP) with auto-reload.
- **SSH** — open and edit a remote folder as if it were local.
- **More** — command palette, custom commands, MDN lookup, ESP32 flashing,
  and a workspace that's restored on next launch.

## Install

Download the installer for your platform from the [Releases page](../../releases):

- **Windows** — `.msi` or `.exe`
- **macOS** — `.dmg` (Apple Silicon / Intel)
- **Linux** — `.AppImage` or `.deb` (x86_64 / ARM64)

Then open a folder and start editing. Some features need their tools installed:
Git, Node.js, PHP, or `espflash`.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Command Palette | `Ctrl+Shift+P` |
| Find / Replace | `Ctrl+F` / `Ctrl+H` |
| Search in files | `Ctrl+Shift+F` |
| Toggle terminal | `` Ctrl+` `` |
| Save · Close tab · New file | `Ctrl+S` · `Ctrl+W` · `Ctrl+N` |
| Multi-cursor · Next match | `Alt+Click` · `Ctrl+D` |

The top menus list everything else.

## Build from source

```sh
# needs Rust + the Tauri CLI; on Linux also webkit2gtk-4.1, gtk3,
# librsvg2, libsoup-3, libssl, libxdo
cd src-tauri
cargo tauri dev      # run
cargo tauri build    # build installers
```
