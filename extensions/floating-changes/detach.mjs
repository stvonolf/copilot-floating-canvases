import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

function browserCandidates() {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA ?? "";
    if (process.platform === "win32") {
        return [
            path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
            path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
            path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe"),
            path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
            path.join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        ];
    }
    if (process.platform === "darwin") {
        return [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ];
    }
    return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

function findBrowser() {
    return browserCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function spawnChecked(file, args, options) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(file, args, options);
        } catch (error) {
            reject(error);
            return;
        }
        const onError = (error) => reject(error);
        child.once("error", onError);
        child.once("spawn", () => {
            child.off("error", onError);
            // A later process error must not crash the extension.
            child.on("error", (error) => {
                process.stderr.write(`[floating-changes] child process error: ${error.message}\n`);
            });
            resolve(child);
        });
    });
}

async function openDefault(url) {
    if (process.platform === "win32") {
        // One quoted command string keeps '&mode=detached' inside the URL;
        // otherwise cmd.exe interprets '&' as a command separator.
        const command = `start "" "${url.replaceAll('"', '""')}"`;
        return spawnChecked(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
        });
    }
    if (process.platform === "darwin") return spawnChecked("open", [url], { detached: true, stdio: "ignore" });
    return spawnChecked("xdg-open", [url], { detached: true, stdio: "ignore" });
}

export async function openFloatingWindow(url, { width = 1120, height = 760 } = {}) {
    const browser = findBrowser();
    if (!browser) {
        const child = await openDefault(url);
        return { mode: "browser", browser: null, child, cleanup: async () => {} };
    }

    const profileDir = await mkdtemp(path.join(tmpdir(), "copilot-changes-"));
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        for (let attempt = 0; attempt < 8; attempt++) {
            try {
                await rm(profileDir, { recursive: true, force: true });
                return;
            } catch (error) {
                if (error.code !== "EBUSY" || attempt === 7) throw error;
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    };
    try {
        const child = await spawnChecked(
            browser,
            [
                `--app=${url}`,
                `--user-data-dir=${profileDir}`,
                `--window-size=${width},${height}`,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-features=Translate,MediaRouter",
            ],
            { stdio: "ignore" },
        );
        child.once("exit", () => void cleanup());
        return { mode: "app-window", browser, child, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
