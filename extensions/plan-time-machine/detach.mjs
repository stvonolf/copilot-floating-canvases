import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlanError } from "./history.mjs";

// Kept inside this extension so it remains independently installable.
export function findBrowser() {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA;
    const candidates = process.platform === "win32" ? [
        ...(local ? [path.join(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ] : process.platform === "darwin" ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ] : [
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium",
        "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/snap/bin/chromium",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function removeProfile(profile) {
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
}

async function closeBrowser(profile) {
    const info = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
    const [port, endpoint] = info.trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 ||
        !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)) {
        throw new PlanError("window_close_failed", "The owned browser's local control endpoint is invalid.");
    }
    await new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
        let sent = false;
        let finished = false;
        const finish = (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.close();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error("The owned browser did not respond to its close request.")), 1500);
        socket.addEventListener("open", () => {
            sent = true;
            socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        });
        socket.addEventListener("message", (event) => {
            let message;
            try { message = JSON.parse(String(event.data)); }
            catch { finish(new Error("The owned browser returned an invalid close response.")); return; }
            if (message.id === 1) finish(message.error ? new Error(message.error.message) : null);
        });
        socket.addEventListener("close", () => finish(sent ? null : new Error("The owned browser closed its control connection before the request.")));
        socket.addEventListener("error", () => finish(new Error("Cannot connect to the owned browser's local control endpoint.")));
    });
}

export async function openFloatingWindow(url, { onError = console.error, browserPath = findBrowser() } = {}) {
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
        throw new PlanError("invalid_window_url", "Floating windows must use the local plan server.");
    }
    if (!browserPath) {
        throw new PlanError("browser_unavailable", "Pop out requires Chrome, Edge, Brave, or Chromium in a standard installation location. The plan remains available in this panel.");
    }
    const profile = await mkdtemp(path.join(tmpdir(), "copilot-plan-window-"));
    let child;
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= removeProfile(profile).catch((error) => {
        cleanupPromise = null;
        throw error;
    });
    try {
        child = spawn(browserPath, [
            `--app=${target.href}`, `--user-data-dir=${profile}`, "--window-size=820,900",
            "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
            "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
            "--disable-features=Translate,MediaRouter",
        ], { stdio: "ignore", windowsHide: false });
        await new Promise((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
        });
    } catch (error) {
        await cleanup();
        throw new PlanError("window_launch_failed", `Could not open the floating window: ${error.message}`);
    }
    let exited = false;
    child.on("error", onError);
    const closed = new Promise((resolve) => {
        const finish = (code, signal) => {
            if (exited) return;
            exited = true;
            resolve({ code, signal });
            void cleanup().catch(onError);
        };
        child.once("exit", finish);
        if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
    });
    const waitForExit = async (milliseconds) => {
        let timer;
        try {
            return await Promise.race([
                closed.then(() => true),
                new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    let closing;
    return {
        child, profile, closed,
        close() {
            return closing ??= (async () => {
                if (!exited) {
                    let terminationError = null;
                    try {
                        await closeBrowser(profile);
                    } catch (error) {
                        terminationError = error;
                    }
                    if (!await waitForExit(1000)) {
                        try {
                            // A browser may acknowledge Browser.close but hang in shutdown.
                            // Terminate only this extension's retained process handle.
                            if (!child.kill("SIGKILL")) terminationError = new Error("The owned process did not accept the close signal.");
                        } catch (error) {
                            terminationError = error;
                        }
                        if (!await waitForExit(3000)) {
                            throw new PlanError("window_close_failed", terminationError
                                ? `Could not close the owned floating window: ${terminationError.message}`
                                : "The floating window did not exit. Close it manually and retry.");
                        }
                    }
                }
                await cleanup();
            })().catch((error) => {
                closing = null;
                throw error;
            });
        },
    };
}
