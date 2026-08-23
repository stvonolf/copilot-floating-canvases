// Shared helpers for the floating-terminal test suite.
import { chromium } from "playwright";

export const PROMPT_START = "PS ";

let browser = null;
export async function getBrowser() {
    browser ??= await chromium.launch();
    return browser;
}
export async function closeBrowser() {
    await browser?.close();
    browser = null;
}

/** Visible rows, trailing whitespace stripped, blank rows dropped. */
export async function rowsOf(page) {
    return page.evaluate(() =>
        [...document.querySelectorAll(".xterm-rows > div")]
            .map((d) => d.innerText.replace(/\u00a0/g, " ").replace(/\s+$/, ""))
            .filter((x) => x.length),
    );
}

/** Rows joined with wrapping removed, for width-independent assertions. */
export async function flatText(page) {
    return (await rowsOf(page)).join("").replace(/\s+/g, " ");
}

export function promptCount(rows) {
    return rows.filter((r) => r.startsWith(PROMPT_START)).length;
}

/**
 * Detect a screen that the shell drew at the wrong coordinates.
 *
 * A healthy screen only ever has the prompt at the start of a row, and every
 * such row is a prefix of the real prompt (a narrow terminal legitimately cuts
 * it mid-path). Anything else means text landed on top of the prompt.
 */
export function findCorruption(rows, promptPrefix) {
    const bad = [];
    for (const r of rows) {
        if (r.includes("^C")) bad.push(`stray ^C: ${JSON.stringify(r)}`);
        else if (r.includes(PROMPT_START) && !r.startsWith(PROMPT_START))
            bad.push(`prompt not at line start: ${JSON.stringify(r)}`);
        else if (r.startsWith(PROMPT_START) && !(r.startsWith(promptPrefix) || promptPrefix.startsWith(r)))
            bad.push(`mangled prompt: ${JSON.stringify(r)}`);
    }
    return bad;
}

export class Ctx {
    constructor(base, promptPrefix) {
        this.base = base;
        this.promptPrefix = promptPrefix;
        this.failures = [];
        this.passes = 0;
        this.current = "";
    }

    section(name) {
        this.current = name;
        console.log(`\n  ${name}`);
    }

    check(label, actual, expected) {
        const ok = JSON.stringify(actual) === JSON.stringify(expected);
        if (ok) {
            this.passes++;
            console.log(`    PASS  ${label}`);
        } else {
            this.failures.push(`${this.current} :: ${label} -> got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
            console.log(`    FAIL  ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
        }
        return ok;
    }

    async clean(label, page) {
        const rows = await rowsOf(page);
        const bad = findCorruption(rows, this.promptPrefix);
        if (bad.length === 0) {
            this.passes++;
            console.log(`    PASS  ${label} (no corruption)`);
            return true;
        }
        bad.forEach((b) => {
            this.failures.push(`${this.current} :: ${label} -> ${b}`);
            console.log(`    FAIL  ${label}: ${b}`);
        });
        return false;
    }

    async state(terminalId) {
        const res = await fetch(`${this.base}/api/state?t=${encodeURIComponent(terminalId)}`);
        const json = await res.json();
        return json.terminals.find((t) => t.terminalId === terminalId);
    }

    async size(terminalId) {
        return (await this.state(terminalId))?.size;
    }
}

/** Open a surface and wait for the shell to be ready. */
export async function openSurface(base, terminalId, { width, height, mode = "panel" }) {
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.__errors = errors;
    await page.goto(`${base}/?t=${encodeURIComponent(terminalId)}&mode=${mode}`);
    await page.waitForTimeout(2800);
    await page.locator(".xterm-screen").click();
    return page;
}

/** Type a command and wait for it to finish. */
export async function runCommand(page, command, waitMs = 2600) {
    await page.locator(".xterm-screen").click();
    await page.keyboard.type(`${command}\r`);
    await page.waitForTimeout(waitMs);
}

export async function typeText(page, text, waitMs = 900) {
    await page.locator(".xterm-screen").click();
    await page.keyboard.type(text);
    await page.waitForTimeout(waitMs);
}

export async function clearLine(page, length) {
    for (let i = 0; i < length; i++) await page.keyboard.press("Backspace");
    await page.waitForTimeout(700);
}

export async function resize(page, width, height, settleMs = 2800) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(settleMs);
}

export function uniqueId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The grid the surface is actually rendering, straight from xterm. */
export async function clientCols(page) {
    return page.evaluate(() => window.__term?.cols ?? 0);
}
export async function clientRows(page) {
    return page.evaluate(() => window.__term?.rows ?? 0);
}
