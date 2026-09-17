# Copilot Floating Canvases

Three experimental canvas extensions for the GitHub Copilot app:

| Extension | Description |
| --- | --- |
| **Floating terminal** | A real PTY-backed terminal that can move between the Copilot panel and its own OS window. |
| **Floating changes** | Git diffs plus **Since You Looked** review checkpoints and persistent file feedback. Never changes your code or Git index. |
| **Plan Time Machine** | A compact, read-only browser for the native plan's saved revisions and live working changes. |

All three extensions run locally and bind their renderer to loopback only. Floating terminal and Floating changes can be moved to another monitor with **Pop out**.

> [!NOTE]
> Copilot's canvas extension API is experimental and may change between app releases.

## Requirements

- A GitHub Copilot app/CLI build with canvas extension support
- Git
- Node.js and npm, to install the terminal and Plan Time Machine runtime packages (Node.js 22+ for Plan Time Machine)
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
Copy-Item ".\extensions\plan-time-machine" $extensionRoot -Recurse -Force

Push-Location (Join-Path $extensionRoot "floating-terminal")
npm ci --omit=dev
Pop-Location

Push-Location (Join-Path $extensionRoot "plan-time-machine")
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
cp -R extensions/plan-time-machine ~/.copilot/extensions/
(cd ~/.copilot/extensions/floating-terminal && npm ci --omit=dev)
(cd ~/.copilot/extensions/plan-time-machine && npm ci --omit=dev)
```

Reload extensions from the Copilot command palette, run `/clear`, or restart the app.

## Use

Ask Copilot to open a canvas:

```text
Open the floating terminal.
Open floating changes.
Open Plan Time Machine.
```

For either floating canvas, select **Pop out** to move it into a separate window.

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
- Never stages, discards, or edits working-tree files; review metadata is stored separately

#### Since You Looked

Choose **Since you looked** inside Floating changes to compare the current working files with your last explicit review checkpoint. The normal **Git changes** mode and pop-out controls remain available.

1. Review your current work in **Git changes**, then switch to **Since you looked** and explicitly start a checkpoint from the current files. Opening the canvas never marks anything reviewed automatically.
2. Continue developing. The review mode shows additions, edits, deletions, renames, and binary changes since that checkpoint, including edits to files that were clean when you started.
3. Add file-level feedback as needed. Feedback stays open until you explicitly resolve it; **All feedback** keeps notes accessible even when the file is no longer in the delta.
4. Select **Mark all reviewed** after reviewing the changes. This advances the checkpoint for the entire working tree, not just filtered or selected files, and does not resolve feedback.

If files changed after the displayed view loaded, marking reviewed is rejected. Refresh and inspect the new changes before trying again. Diffs are tied to the displayed snapshot, so a selected diff never quietly changes its comparison inputs. Feedback records which file contents it referred to and warns when the file has changed since the comment; it does not claim the comment has been addressed.

Checkpoints contain **tracked files plus non-ignored untracked files**. They represent working-file content, not staged versus unstaged layers: staging or committing unchanged content does not make it appear again. Ignored untracked files are excluded. Switching branches can produce a large delta, because branch contents changed; checkpoints are never silently reset. This feature does not automatically import native PR review comments or identify agent turn boundaries.

Review snapshots and feedback are stored under `files/floating-changes-review/<repository-key>` in the SDK's session workspace. Both the panel and its floating window share that data; closing/reopening the panel or reloading the extension does not erase it. Different sessions and worktree roots are isolated. Git refs, index, configuration, and source files in your project are never modified. The private object store can retain previously inspected contents and is removed with the session's state; it is not pushed to GitHub. No remote services or model calls are needed.

The current limits are **10,000 files, 16 MiB per file, and 256 MiB total**. Incomplete snapshots are refused rather than silently marked reviewed. Repositories with unresolved conflicts, submodules, or skip-worktree/sparse entries must use the normal Git view. Symlink targets are recorded as links rather than followed, and linked parent directories are not traversed. Native session storage must be available to use review mode.

The agent can inspect review state and feedback through `get_review_status` and `get_review_diff`. Advancing checkpoints and resolving feedback are deliberately user controls, not agent-callable approval actions.
To open directly in review mode, ask for Floating changes with `view: "review"`. Pop out preserves the active view.

### Plan Time Machine

- Automatically tracks the current session's native `plan.md` using the SDK's session workspace path. There is no file picker or separate planning workflow.
- Begins tracking when the extension loads, including while its panel is closed. Start native **Plan** mode normally; the panel waits if no plan exists yet.
- Captures a plan-only Git revision after five seconds without observed changes. **Capture now** saves the current version immediately; neither action approves the plan.
- Shows **Working changes** above saved revisions, exact diffs from each parent, full Markdown snapshots, and paginated older history.
- Preserves the selected historical revision while the plan changes. Deleted plans leave saved history intact.
- Uses a compact side-panel layout with light, dark, and system appearance.
- Never modifies the native plan, your code, the application branch, or your Git configuration. Native plan approval remains in Copilot.

History lives in `files/plan-time-machine/history.git` inside the current SDK session workspace, alongside (not inside) the native `plan.md`. It survives panel closes and extension reloads in that session, but is not synchronized or committed to your project. Removing the session's state removes its history too. The extension cannot reconstruct revisions from before it began tracking or changes overwritten between its one-second polls.

Working changes are read from the native file, not a second editable plan. Pending edits remain uncommitted until capture; diff previews may write unreferenced blobs to the local history object store. No plan content is sent to a model or remote service. The renderer requires a per-provider capability token for data access and sanitizes Markdown; remote images and embedded content are not loaded.

Plans must be regular UTF-8 files up to **1 MiB and 20,000 lines**. Unsupported files, unavailable Git, and read/capture errors are reported explicitly rather than showing a truncated plan as complete. When the runtime does not supply a session workspace, the extension reports that native plan tracking is unavailable.

Agent-callable actions are `get_status`, `get_revision` (`id: "working"` or a full saved SHA), `get_history` (optional `before` cursor), and `capture_revision`. Canvas open input is `{}`.

## Update

Pull the latest version and repeat the copy steps:

```shell
git pull
```

Run `npm ci --omit=dev` again inside the installed `floating-terminal` directory whenever its lockfile changes.
Do the same inside `plan-time-machine` when its lockfile changes.

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

Run the review-mode suites from `extensions/floating-changes/tests`:

```shell
npm run test:review
npm run test:review-ui
```

The review browser suite uses Microsoft Edge by default. Set `REVIEW_TEST_BROWSER=chromium` after `npx playwright install chromium` to use Playwright's Chromium. Fixtures are isolated from your real files and review checkpoints.

Plan Time Machine has dependency-free backend tests and separate browser tests:

```shell
cd extensions/plan-time-machine
npm ci
cd tests
npm ci
npm test
npm run test:ui
```

The browser tests use installed Microsoft Edge by default. To use Playwright's Chromium instead, install it with `npx playwright install chromium` and set `PLAN_TEST_BROWSER=chromium`. The tests create isolated session fixtures; they never write a plan into your real session.

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
  plan-time-machine/
    extension.mjs
    history.mjs
    tracker.mjs
    server.mjs
    ui/
    tests/
```

Each folder can be installed independently.

## License

[MIT](LICENSE)
