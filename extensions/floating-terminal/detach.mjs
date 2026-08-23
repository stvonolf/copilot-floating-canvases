// Detaching a canvas into a real OS window.
//
// The host renders canvases inside its own side panel, and there's no SDK verb
// for "give me a floating window". But a canvas is just a URL served by this
// extension, so we can point a second, independent window at the same URL.
//
// Chromium's `--app=` flag gives a frameless window with no tabs and no address
// bar, which reads as a native panel and can be dragged to any monitor. We fall
// back to the default browser when no Chromium build is found.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

function candidateBrowsers() {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? "";

    if (process.platform === "win32") {
        return [
            path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
            path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
            path.join(pf86, "Google\\Chrome\\Application\\chrome.exe"),
            path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
            path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
            path.join(local, "Programs\\Opera\\opera.exe"),
            path.join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ];
    }
    return [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/snap/bin/chromium",
    ];
}

function findBrowser() {
    return candidateBrowsers().find((candidate) => existsSync(candidate)) ?? null;
}

function openInDefaultBrowser(url) {
    if (process.platform === "win32") return spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    if (process.platform === "darwin") return spawn("open", [url], { detached: true, stdio: "ignore" });
    return spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
}

/**
 * Spawn a floating window showing `url`.
 * @returns {Promise<{ mode: "app-window" | "browser", browser: string | null, child: import("node:child_process").ChildProcess }>}
 */
export async function openFloatingWindow(url, { width = 900, height = 600 } = {}) {
    const browser = findBrowser();
    if (!browser) {
        return { mode: "browser", browser: null, child: openInDefaultBrowser(url) };
    }

    // A dedicated profile dir forces a genuinely separate browser process, so
    // closing the window is observable to us and it never merges into a window
    // the user already had open.
    const profileDir = await mkdtemp(path.join(tmpdir(), "copilot-floating-"));

    const child = spawn(
        browser,
        [
            `--app=${url}`,
            `--user-data-dir=${profileDir}`,
            `--window-size=${width},${height}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-features=Translate,MediaRouter",
        ],
        { detached: false, stdio: "ignore" },
    );

    return { mode: "app-window", browser, child };
}
