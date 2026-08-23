# floating-terminal tests

Behavioural suite for the floating terminal. It drives the real UI in Chromium,
against a real shell, and asserts on what is actually rendered.

```bash
npm install                 # once
npm test                    # everything, against a private server
node suite.mjs --filter resize
node suite.mjs --port 1234  # against a running extension instance

node reaper.mjs 1234        # idle-terminal cleanup (slow: waits out the grace period)
```

By default the suite boots its own copy of the extension's server in a
directory with a deliberately long name. That verifies the prompt is capped
rather than leaking an arbitrarily long path into the input line. Running with
`--port` instead exercises the live extension as a second data point.

## What it covers

| Group | Checks |
| --- | --- |
| `startup` | shell spawns at the surface's size, renders, runs commands |
| `reload keeps history` | reconnecting a surface replays the screen |
| `resize` | 24 shapes: widen/narrow, height-only, idle, half-typed, and a 140-character wrapped command |
| `resize mid-command then continue typing` | start a command, resize, carry on typing the same command, run it |
| `resize during output` | resizing while a command is still printing |
| `rapid drag` | continuous resize streams: widen, narrow, zigzag, 40-step fine-grained drags, height-only, both axes — each idle and with a half-typed command |
| `type immediately after drag` | typing before a drag has settled |
| `resize then type, both surfaces` | resize then type, in the panel and in a detached surface, asserting the input line and backspace behaviour |
| `pop out` | attaching a second surface leaves the shell untouched; history and typed text carry over; pop-in restores the panel |
| `pop out into a real OS window` | the same, through the detach endpoint that spawns an actual window |
| `resize floating window` | resizing the detached surface |
| `two surfaces share one shell` | one PTY, output visible on both |
| `stale surfaces are rejected` | a surface from a dead process is closed with 4001 |
| `unknown terminal actions fail cleanly` | detach/attach on a missing terminal |
| `environment is supported` | PowerShell 7 is in use and no notice is shown |

`reaper.mjs` is separate because it has to wait out the 90-second grace period.
A terminal whose surfaces have all disconnected is disposed after that, and a
surface reconnecting inside the window rescues it. Without this a shell outlived
every surface that could show it: one suite run left 65 orphaned `pwsh`
processes holding about 6 GB.

## What a resize costs

**Nothing.** The suite asserts zero added prompt lines for every resize shape,
every drag, and both the panel and detached surfaces.

That is made possible by the shell configuration:

- PowerShell 7 is required;
- predictive suggestions are disabled (`PredictionSource None`), so ghost text
  cannot silently extend the input line until it wraps;
- the prompt is bounded to the current directory's leaf name (28 characters
  maximum), so a long working directory cannot make ordinary commands start on
  a wrapped line.

The combination was also tested against a raw pty with no extension code in the
way: short input, wrapped 100/120/180-character input, widen, narrow, and
wrapped-to-wrapped resize all remained intact.

## Why PowerShell 7 is required

Windows PowerShell 5.1 ships PSReadLine 2.0 (2019), which loses the prompt
position on routine resizes. Measured on a raw pty with no repair applied:

| Shell | Input line intact after resize |
| --- | --- |
| Windows PowerShell 5.1 (PSReadLine 2.0.0) | 1 of 5 cases |
| PowerShell 7 (PSReadLine 2.4.5) | 5 of 5 cases |

Several workarounds for 5.1 were tested and rejected: arrow/Home/End/Delete/
Backspace don't restore the position; `Ctrl+C` works but leaves a visible `^C`;
`Ctrl+L` works but clears the screen; PSReadLine's `InvokePrompt()` would be
ideal but no key chord reaches it through ConPTY. So the extension refuses to
run on 5.1 and explains how to install PowerShell 7 rather than degrading.

## Detecting a broken screen

Two independent checks, because each misses what the other catches:

- `findCorruption` scans every row for a prompt that is not at the start of a
  line or does not match the real prompt. This catches text drawn on top of the
  prompt.
- `inputLineIsIntact` rebuilds the input line across wrapping and compares it to
  "prompt + what was typed". This catches damage on a wrapped continuation row,
  which the row-by-row scan cannot see — including an off-by-one column shift
  that silently ate the prompt's trailing space.

Prompt lines are counted at **every** stage — after the resize, after typing,
and after running a command. Counting only immediately after the resize once
hid a regression, because the damage appeared on the next keystroke.
