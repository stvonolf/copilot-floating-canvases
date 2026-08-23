# Copilot Floating Canvases

Two experimental canvas extensions for the GitHub Copilot app:

| Extension | Description |
| --- | --- |
| **Floating terminal** | A real PTY-backed terminal that can move between the Copilot panel and its own OS window. |
| **Floating changes** | A read-only Git changes browser with staged, working-tree, untracked, and conflict groups plus unified diffs. |

Both extensions run locally, bind their renderer to loopback only, and can be moved to another monitor with **Pop out**.

> [!NOTE]
> Copilot's canvas extension API is experimental and may change between app releases.

## Requirements

- A GitHub Copilot app/CLI build with canvas extension support
- Git
- Node.js and npm, to install the terminal extension's runtime packages
- **Windows only:** [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)

The terminal intentionally refuses to use Windows PowerShell 5.1 because its old PSReadLine version loses the prompt cursor during terminal resizing.

## Install

Clone the repository:

```shell
git clone https://github.com/stvonolf/copilot-floating-canvases.git
cd copilot-floating-canvases
```

### Windows PowerShell

```powershell
$extensionRoot = Join-Path $HOME ".copilot\extensions"
New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null

Copy-Item ".\extensions\floating-terminal" $extensionRoot -Recurse -Force
Copy-Item ".\extensions\floating-changes" $extensionRoot -Recurse -Force

Push-Location (Join-Path $extensionRoot "floating-terminal")
npm ci --omit=dev
Pop-Location
```

If PowerShell 7 is not installed:

```powershell
winget install Microsoft.PowerShell
```

### macOS or Linux

```shell
mkdir -p ~/.copilot/extensions
cp -R extensions/floating-terminal ~/.copilot/extensions/
cp -R extensions/floating-changes ~/.copilot/extensions/
(cd ~/.copilot/extensions/floating-terminal && npm ci --omit=dev)
```

Reload extensions from the Copilot command palette, run `/clear`, or restart the app.

## Use

Ask Copilot to open either canvas:

```text
Open the floating terminal.
Open floating changes.
```

Then select **Pop out** in the canvas toolbar to move it into a separate window.

### Floating terminal

- Uses one shared PTY across the panel and floating window
- Preserves history while moving between surfaces
- Uses PowerShell 7 on Windows and the default login shell on macOS/Linux
- Uses a bounded `PS <folder>` prompt and disables predictive suggestions so resizing remains cursor-safe
- Reaps shells after their last surface has been disconnected for 90 seconds

The terminal is a live shell with the same permissions as the Copilot process.

### Floating changes

- Shows conflicts, staged changes, working-tree changes, and untracked files
- Shows per-file addition/deletion totals
- Switches between staged and working-tree diffs when a file has both
- Polls for updates without resetting the diff scroll position
- Is strictly read-only: it never stages, discards, or edits files

## Update

Pull the latest version and repeat the copy steps:

```shell
git pull
```

Run `npm ci --omit=dev` again inside the installed `floating-terminal` directory whenever its lockfile changes.

## Test

Install test dependencies separately:

```shell
cd extensions/floating-terminal/tests
npm ci
npm test
```

```shell
cd extensions/floating-changes/tests
npm ci
npm test
```

The terminal suite covers resize/cursor behavior, wrapped commands, panel and detached surfaces, pop-out lifecycle, and shell reaping.

The changes suite creates isolated Git repositories and covers conflicts, staged and unstaged overlap, renames, deletions, untracked files, diff switching, polling, filtering, token isolation, pop-out lifecycle, and read-only guarantees.

## Repository layout

```text
extensions/
  floating-terminal/
    extension.mjs
    ui/
    tests/
  floating-changes/
    extension.mjs
    ui/
    tests/
```

Each folder can be installed independently.

## License

[MIT](LICENSE)
