// Full behavioural suite for the floating terminal.
//
// Boots its own server so the tests are self-contained and deterministic: the
// working directory is chosen to give a long shell prompt, which is what makes
// line wrapping (and therefore the resize edge cases) reproducible.
//
//   node suite.mjs              run everything against a private server
//   node suite.mjs --port 1234  run against an already-running extension
//   node suite.mjs --filter re  only groups whose name matches

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    Ctx,
    clearLine,
    clientCols,
    clientRows,
    closeBrowser,
    flatText,
    openSurface,
    promptCount,
    resize,
    rowsOf,
    runCommand,
    typeText,
    uniqueId,
} from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
};
const filter = argOf("--filter");
const externalPort = argOf("--port");

// A long path keeps the default PowerShell prompt long enough to wrap at
// ordinary panel widths, which is exactly where the interesting cases live.
const WORKDIR = path.join(
    os.tmpdir(),
    "floating-terminal-suite",
    "a-deliberately-long-working-directory-name-for-prompt-wrapping",
);

let serverProc = null;

async function startServer() {
    if (externalPort) return { base: `http://127.0.0.1:${externalPort}`, external: true };

    mkdirSync(WORKDIR, { recursive: true });
    return await new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [path.join(here, "serve.mjs")], {
            cwd: WORKDIR,
            stdio: ["ignore", "pipe", "pipe"],
        });
        serverProc = proc;
        let out = "";
        let resolved = false;
        const timer = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20000);
        proc.stdout.on("data", (c) => {
            out += c.toString();
            const m = out.match(/PORT=(\d+)/);
            if (m && !resolved) {
                resolved = true;
                clearTimeout(timer);
                const ptyLine = out.match(/ENV=(.*)/)?.[1] ?? "starting";
                console.log(`server on port ${m[1]}  (${ptyLine})`);
                resolve({ base: `http://127.0.0.1:${m[1]}`, external: false });
            }
        });
        proc.stderr.on("data", (c) => (out += c.toString()));
        proc.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`server exited with ${code}: ${out}`));
        });
    });
}

function stopServer() {
    serverProc?.kill();
    serverProc = null;
}

// ---------------------------------------------------------------------------
// Measure the prompt once so every expectation can be derived rather than
// hard-coded. Wrapping depends on prompt length versus column count.
// ---------------------------------------------------------------------------
async function measurePrompt(ctx) {
    const id = uniqueId("measure");
    const page = await openSurface(ctx.base, id, { width: 1500, height: 420 });
    await page.waitForTimeout(500);
    const rows = await rowsOf(page);
    const promptRow = [...rows].reverse().find((r) => /^PS .+>$/.test(r)) ?? "";
    await page.close();
    // The rendered row has its trailing space trimmed; the cursor sits one
    // column past the text.
    return { text: promptRow, length: promptRow.length + 1 };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------
const groups = [];
const group = (name, fn) => groups.push({ name, fn });

// --- lifecycle -------------------------------------------------------------
group("startup", async (ctx) => {
    const id = uniqueId("start");
    const page = await openSurface(ctx.base, id, { width: 700, height: 420 });

    ctx.check("prompt rendered (not blank)", (await rowsOf(page)).length > 0, true);
    const state = await ctx.state(id);
    ctx.check("shell started", state?.started, true);
    ctx.check("one client attached", state?.clients, 1);
    ctx.check("shell grid matches surface", Number(state.size.split("x")[0]), await clientCols(page));
    ctx.check("prompt is bounded", ctx.promptLen <= 33, true);
    ctx.check("prompt shows only the cwd leaf", ctx.promptText.includes("\\"), false);

    await runCommand(page, "echo HELLO");
    ctx.check("command output shown", (await flatText(page)).includes("HELLO"), true);
    await runCommand(page, "Write-Output ('PREDICTION=' + (Get-PSReadLineOption).PredictionSource)");
    ctx.check("predictive suggestions are disabled", (await flatText(page)).includes("PREDICTION=None"), true);
    await ctx.clean("after command", page);
    ctx.check("no page errors", page.__errors, []);
    await page.close();
});

group("reload keeps history", async (ctx) => {
    const id = uniqueId("reload");
    const page = await openSurface(ctx.base, id, { width: 700, height: 420 });
    await runCommand(page, "echo BEFORE_RELOAD");

    await page.reload();
    await page.waitForTimeout(3000);

    ctx.check("history restored after reload", (await flatText(page)).includes("BEFORE_RELOAD"), true);
    await ctx.clean("after reload", page);
    await runCommand(page, "echo AFTER_RELOAD");
    ctx.check("still usable", (await flatText(page)).includes("AFTER_RELOAD"), true);
    await page.close();
});

// --- resize ----------------------------------------------------------------
//
// The rule under test: a resize is applied immediately and never touches the
// shell, unless it changes whether the current input line wraps - in which case
// the line is re-established, costing exactly one prompt.
/**
 * The whole input line, reconstructed across wrapping. Comparing this against
 * "prompt + what was typed" catches text drawn at the wrong coordinates even
 * when the damage lands on a wrapped continuation row, which a row-by-row
 * check cannot see.
 */
async function inputLineIsIntact(ctx, page, typed) {
    const flat = await flatText(page);
    return flat.includes(`${ctx.promptText} ${typed}`.replace(/\s+/g, " "));
}

// PowerShell 7 runs with a bounded prompt and predictions disabled, so every
// resize must be silent - including genuinely long commands that wrap.
const EXPECTED_PROMPT_LINES = 0;

group("resize", async (ctx) => {
    for (const pending of [null, "git s", "x".repeat(140)]) {
        for (const [kind, fromW, toW, fromH, toH] of [
            ["large widen", 620, 1500, 420, 420],
            ["large narrow", 1500, 620, 420, 420],
            ["small narrow", 620, 520, 420, 420],
            ["small widen", 520, 620, 420, 420],
            ["wide widen", 1300, 1500, 420, 420],
            ["wide narrow", 1500, 1300, 420, 420],
            ["height only (taller)", 700, 700, 420, 700],
            ["height only (shorter)", 700, 700, 700, 420],
        ]) {
            const id = uniqueId("rz");
            const page = await openSurface(ctx.base, id, { width: fromW, height: fromH });
            await runCommand(page, "echo SETUP", 2000);
            const baseline = promptCount(await rowsOf(page));

            if (pending) await typeText(page, pending);

            // Read the grid the surface actually renders, before and after.
            const colsBefore = await clientCols(page);
            const rowsBefore = await clientRows(page);
            await resize(page, toW, toH);
            const colsAfter = await clientCols(page);
            const rowsAfter = await clientRows(page);

            const expected = EXPECTED_PROMPT_LINES;

            ctx.section(
                `resize: ${kind}${pending ? ` + ${pending.length}-char input` : ""} ` +
                    `[${colsBefore}x${rowsBefore} -> ${colsAfter}x${rowsAfter}]`,
            );

            // The shell must always end up matching the surface it is shown in.
            const serverSize = await ctx.size(id);
            ctx.check("shell grid matches surface", Number(serverSize.split("x")[0]), colsAfter);
            ctx.check("width actually changed", colsBefore !== colsAfter, fromW !== toW);
            await ctx.clean("after resize", page);

            let rows = await rowsOf(page);
            const addedByResize = promptCount(rows) - baseline;
            ctx.check("prompt lines added", addedByResize, expected);
            ctx.check("history preserved", (await flatText(page)).includes("SETUP"), true);
            if (pending) ctx.check("typed text preserved", await inputLineIsIntact(ctx, page, pending), true);

            // Typing after the resize must render correctly and add nothing more.
            if (pending) await clearLine(page, pending.length);
            await typeText(page, "echo TYPED", 1200);
            await ctx.clean("while typing", page);
            rows = await rowsOf(page);
            ctx.check("typing adds no further prompt lines", promptCount(rows) - baseline, addedByResize);
            ctx.check("input line intact", await inputLineIsIntact(ctx, page, "echo TYPED"), true);

            await page.keyboard.press("Enter");
            await page.waitForTimeout(2200);
            await ctx.clean("after running", page);
            ctx.check("command ran", (await flatText(page)).includes("TYPED"), true);
            ctx.check("no page errors", page.__errors, []);
            await page.close();
        }
    }
});

group("resize during output", async (ctx) => {
    const id = uniqueId("busy");
    const page = await openSurface(ctx.base, id, { width: 620, height: 420 });
    await runCommand(page, "echo SETUP", 1800);

    // Start something that prints for a while, then resize mid-flight.
    await typeText(page, "1..20 | ForEach-Object { $_; Start-Sleep -Milliseconds 60 }", 600);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    await resize(page, 1250, 420, 2500);
    await page.waitForTimeout(2500);

    await ctx.clean("after resize during output", page);
    ctx.check("output completed", (await flatText(page)).includes("20"), true);
    ctx.check("grid followed surface", Number((await ctx.size(id)).split("x")[0]), await clientCols(page));

    await runCommand(page, "echo DONE");
    await ctx.clean("after next command", page);
    ctx.check("still usable", (await flatText(page)).includes("DONE"), true);
    await page.close();
});

// A real window drag emits a continuous stream of resize events, not a single
// jump. The cost of a whole drag must stay bounded - this group failed to
// assert that once, which let a regression through where every intermediate
// step emitted its own prompt.
group("rapid drag", async (ctx) => {
    for (const [label, widths, heights] of [
        ["widen", [620, 700, 800, 900, 1000, 1100, 1250], null],
        ["narrow", [1250, 1100, 1000, 900, 800, 700, 620], null],
        ["zigzag", [900, 700, 1100, 620, 1250, 800], null],
        ["fine-grained widen", Array.from({ length: 40 }, (_, i) => 620 + i * 16), null],
        ["fine-grained narrow", Array.from({ length: 40 }, (_, i) => 1260 - i * 16), null],
        ["height drag", null, Array.from({ length: 30 }, (_, i) => 400 + i * 10)],
        ["both axes", Array.from({ length: 30 }, (_, i) => 620 + i * 20), Array.from({ length: 30 }, (_, i) => 400 + i * 8)],
    ]) {
        for (const pending of [null, "git s"]) {
            ctx.section(`rapid drag: ${label}${pending ? " + half-typed" : ""}`);
            const startW = widths ? widths[0] : 700;
            const startH = heights ? heights[0] : 420;
            const id = uniqueId("drag");
            const page = await openSurface(ctx.base, id, { width: startW, height: startH });
            await runCommand(page, "echo SETUP", 1800);
            const baseline = promptCount(await rowsOf(page));
            if (pending) await typeText(page, pending);

            // Drive the resize stream at roughly the rate a real drag produces.
            const steps = Math.max(widths?.length ?? 0, heights?.length ?? 0);
            for (let i = 1; i < steps; i++) {
                await page.setViewportSize({
                    width: widths ? widths[Math.min(i, widths.length - 1)] : startW,
                    height: heights ? heights[Math.min(i, heights.length - 1)] : startH,
                });
                await page.waitForTimeout(25);
            }
            await page.waitForTimeout(3500);

            await ctx.clean("after drag", page);
            const added = promptCount(await rowsOf(page)) - baseline;
            ctx.check("whole drag adds no prompt", added, EXPECTED_PROMPT_LINES);
            ctx.check("grid settled on final size", Number((await ctx.size(id)).split("x")[0]), await clientCols(page));
            ctx.check("history preserved", (await flatText(page)).includes("SETUP"), true);
            if (pending) ctx.check("typed text preserved", await inputLineIsIntact(ctx, page, pending), true);

            if (pending) await clearLine(page, pending.length);
            await typeText(page, "echo AFTERDRAG", 1300);
            await ctx.clean("while typing", page);
            ctx.check("input line intact", await inputLineIsIntact(ctx, page, "echo AFTERDRAG"), true);
            await page.keyboard.press("Enter");
            await page.waitForTimeout(2400);
            ctx.check("command ran", (await rowsOf(page)).some((r) => r.trim() === "AFTERDRAG"), true);
            ctx.check("no page errors", page.__errors, []);
            await page.close();
        }
    }
});

// Typing immediately after a drag, before the settle timer has fired, must not
// land at the stale origin.
group("type immediately after drag", async (ctx) => {
    for (const [label, from, to] of [
        ["widen", [620, 420], [1250, 420]],
        ["narrow", [1250, 420], [620, 420]],
        ["height", [700, 420], [700, 700]],
    ]) {
        ctx.section(`type right after drag: ${label}`);
        const id = uniqueId("imm");
        const page = await openSurface(ctx.base, id, { width: from[0], height: from[1] });
        await runCommand(page, "echo SETUP", 1800);
        const baseline = promptCount(await rowsOf(page));

        // Resize and type with no settle time in between.
        await page.setViewportSize({ width: to[0], height: to[1] });
        await page.waitForTimeout(120);
        await page.locator(".xterm-screen").click();
        await page.keyboard.type("echo FAST");
        // The repair debounce, plus erasing and replaying the typed text, can
        // take a couple of seconds; wait for it to finish before judging.
        await page.waitForTimeout(5000);

        await ctx.clean("while typing", page);
        ctx.check("input line intact", await inputLineIsIntact(ctx, page, "echo FAST"), true);
        ctx.check("no prompt line added", promptCount(await rowsOf(page)) - baseline, EXPECTED_PROMPT_LINES);

        await page.keyboard.press("Enter");
        await page.waitForTimeout(2400);
        await ctx.clean("after running", page);
        ctx.check("command ran", (await rowsOf(page)).some((r) => r.trim() === "FAST"), true);
        ctx.check("no page errors", page.__errors, []);
        await page.close();
    }
});

// --- pop out ---------------------------------------------------------------
group("pop out", async (ctx) => {
    for (const pending of [null, "git s"]) {
        ctx.section(`pop out${pending ? " with half-typed" : ""}`);
        const id = uniqueId("pop");
        const panel = await openSurface(ctx.base, id, { width: 620, height: 420 });
        await runCommand(panel, "echo SETUP", 1800);
        const baseline = promptCount(await rowsOf(panel));
        const sizeBefore = await ctx.size(id);
        if (pending) await typeText(panel, pending);

        const floating = await openSurface(ctx.base, id, { width: 1250, height: 620, mode: "detached" });
        await floating.waitForTimeout(1200);

        ctx.check("shell grid untouched by attach", await ctx.size(id), sizeBefore);
        await ctx.clean("floating on attach", floating);
        ctx.check("no prompt lines added", promptCount(await rowsOf(floating)) - baseline, 0);
        ctx.check("history replayed", (await flatText(floating)).includes("SETUP"), true);
        if (pending) {
            // Inline autosuggestion appends ghost text, so the row does not end
            // with what was typed - compare the input line as a prefix instead.
            ctx.check("typed text carried over", await inputLineIsIntact(ctx, floating, pending), true);
        }
        ctx.check("panel shows placeholder", await panel.locator("#overlay").isVisible(), true);
        ctx.check("floating hides pop-out button", await floating.locator("#popout").isVisible(), false);
        ctx.check("floating shows pop-in button", await floating.locator("#popin").isVisible(), true);

        // Work inside the floating window.
        if (pending) await clearLine(floating, pending.length);
        await runCommand(floating, "echo INFLOAT");
        await ctx.clean("after running in floating", floating);
        ctx.check("floating ran command", (await flatText(floating)).includes("INFLOAT"), true);

        // Pop back in.
        await floating.close();
        await panel.waitForTimeout(2600);
        ctx.check("overlay hidden after pop-in", await panel.locator("#overlay").isVisible(), false);
        await ctx.clean("panel after pop-in", panel);
        ctx.check("panel has floating history", (await flatText(panel)).includes("INFLOAT"), true);
        await runCommand(panel, "echo BACK");
        ctx.check("panel usable after pop-in", (await flatText(panel)).includes("BACK"), true);
        ctx.check("no page errors", panel.__errors, []);
        await panel.close();
    }
});

group("resize floating window", async (ctx) => {
    for (const [label, to] of [
        ["wider", 1400],
        ["narrower", 700],
    ]) {
        ctx.section(`floating resize ${label}`);
        const id = uniqueId("fr");
        const panel = await openSurface(ctx.base, id, { width: 620, height: 420 });
        await runCommand(panel, "echo SETUP", 1800);

        const floating = await openSurface(ctx.base, id, { width: 1000, height: 620, mode: "detached" });
        await floating.waitForTimeout(1000);

        await resize(floating, to, 620);
        await ctx.clean("after floating resize", floating);
        ctx.check("grid follows floating window", Number((await ctx.size(id)).split("x")[0]), await clientCols(floating));

        await typeText(floating, "echo FLOATRESIZE", 1200);
        await ctx.clean("while typing in floating", floating);
        await floating.keyboard.press("Enter");
        await floating.waitForTimeout(2200);
        ctx.check("command ran", (await flatText(floating)).includes("FLOATRESIZE"), true);

        await floating.close();
        await panel.waitForTimeout(2600);
        await ctx.clean("panel after pop-in", panel);
        await panel.close();
    }
});

// The literal sequence that kept regressing: start a command, resize, then
// carry on typing the SAME command and run it. Distinct from the resize group,
// which clears the line first.
group("resize mid-command then continue typing", async (ctx) => {
    for (const [label, from, to] of [
        ["widen", [620, 420], [1500, 420]],
        ["narrow", [1500, 420], [620, 420]],
        ["slight widen", [620, 420], [700, 420]],
        ["slight narrow", [700, 420], [620, 420]],
        ["taller", [700, 420], [700, 700]],
        ["shorter", [700, 700], [700, 420]],
    ]) {
        ctx.section(`mid-command: ${label}`);
        const id = uniqueId("mid");
        const page = await openSurface(ctx.base, id, { width: from[0], height: from[1] });
        await runCommand(page, "echo SETUP", 1800);

        // Split a command that works in any directory - the suite's own server
        // runs in a scratch dir, so git commands would fail for the wrong reason.
        await typeText(page, "echo MID");
        await resize(page, to[0], to[1]);
        await typeText(page, "COMMAND", 1400);

        await ctx.clean("while typing", page);
        ctx.check("input line reads 'echo MIDCOMMAND'", await inputLineIsIntact(ctx, page, "echo MIDCOMMAND"), true);

        await page.keyboard.press("Enter");
        await page.waitForTimeout(2800);
        await ctx.clean("after running", page);
        ctx.check("command ran", (await rowsOf(page)).some((r) => r.trim() === "MIDCOMMAND"), true);

        // And the shell keeps working afterwards.
        await runCommand(page, "echo STILLGOOD");
        await ctx.clean("after next command", page);
        ctx.check("still usable", (await flatText(page)).includes("STILLGOOD"), true);
        ctx.check("no page errors", page.__errors, []);
        await page.close();
    }
});

// The resize group above drives the panel. This covers the same thing in a
// detached surface, and asserts the cursor column survives - an off-by-one
// there silently eats the prompt's trailing space and puts the next keystroke
// one column early.
group("resize then type, both surfaces", async (ctx) => {
    for (const mode of ["panel", "detached"]) {
        for (const [label, from, to] of [
            ["widen", [700, 500], [1300, 500]],
            ["narrow", [1300, 500], [700, 500]],
            ["taller", [900, 400], [900, 800]],
            ["shorter", [900, 800], [900, 400]],
            ["both axes", [700, 400], [1300, 800]],
        ]) {
            ctx.section(`resize+type (${mode}): ${label}`);
            const id = uniqueId("rt");
            const page = await openSurface(ctx.base, id, { width: from[0], height: from[1], mode });
            await runCommand(page, "echo SETUP", 1800);
            const baseline = promptCount(await rowsOf(page));

            await resize(page, to[0], to[1]);

            const typed = "git status sss";
            await typeText(page, typed, 1600);

            await ctx.clean("while typing", page);
            ctx.check("input line intact", await inputLineIsIntact(ctx, page, typed), true);
            ctx.check("no prompt line added", promptCount(await rowsOf(page)) - baseline, EXPECTED_PROMPT_LINES);

            // Backspacing must land on the typed text, not the prompt.
            await clearLine(page, 4);
            ctx.check("backspace stays in the input", await inputLineIsIntact(ctx, page, "git status"), true);

            ctx.check("no page errors", page.__errors, []);
            await page.close();
        }
    }
});

group("pop out into a real OS window", async (ctx) => {
    for (const pending of [null, "git s"]) {
        ctx.section(`real window${pending ? " with half-typed" : ""}`);
        const id = uniqueId("real");
        const panel = await openSurface(ctx.base, id, { width: 620, height: 420 });
        await runCommand(panel, "echo SETUP", 1800);
        const baseline = promptCount(await rowsOf(panel));
        const sizeBefore = await ctx.size(id);
        if (pending) await typeText(panel, pending);

        const res = await (await fetch(`${ctx.base}/api/detach?t=${id}`, { method: "POST" })).json();
        await new Promise((r) => setTimeout(r, 5000));

        ctx.check("spawned a frameless app window", res.mode, "app-window");
        ctx.check("shell grid untouched", await ctx.size(id), sizeBefore);
        ctx.check("terminal marked detached", (await ctx.state(id))?.detached, true);
        ctx.check("panel shows placeholder", await panel.locator("#overlay").isVisible(), true);

        // Pull it back.
        const attach = await (await fetch(`${ctx.base}/api/attach?t=${id}`, { method: "POST" })).json();
        ctx.check("attach acknowledged", attach.ok, true);
        await panel.waitForTimeout(3000);

        ctx.check("overlay hidden after pop-in", await panel.locator("#overlay").isVisible(), false);
        await ctx.clean("panel after round trip", panel);
        ctx.check("no prompt lines added by round trip", promptCount(await rowsOf(panel)) - baseline, 0);
        ctx.check("history preserved", (await flatText(panel)).includes("SETUP"), true);
        if (pending) ctx.check("typed text preserved", await inputLineIsIntact(ctx, panel, pending), true);

        if (pending) await clearLine(panel, pending.length);
        await runCommand(panel, "echo AFTERPOP");
        await ctx.clean("after running", panel);
        ctx.check("still usable", (await flatText(panel)).includes("AFTERPOP"), true);
        ctx.check("no page errors", panel.__errors, []);
        await panel.close();
    }
});

group("two surfaces share one shell", async (ctx) => {
    const id = uniqueId("share");
    const panel = await openSurface(ctx.base, id, { width: 700, height: 420 });
    await runCommand(panel, "echo FROM_PANEL", 2000);

    const floating = await openSurface(ctx.base, id, { width: 1000, height: 620, mode: "detached" });
    await floating.waitForTimeout(1200);

    ctx.check("floating sees panel history", (await flatText(floating)).includes("FROM_PANEL"), true);
    const state = await ctx.state(id);
    ctx.check("both clients on one shell", state?.clients, 2);
    ctx.check("marked detached", state?.detached, true);

    await runCommand(floating, "echo FROM_FLOAT");
    await floating.close();
    await panel.waitForTimeout(2600);
    ctx.check("panel received floating output", (await flatText(panel)).includes("FROM_FLOAT"), true);
    await panel.close();
});

// --- protocol --------------------------------------------------------------
group("stale surfaces are rejected", async (ctx) => {
    const id = uniqueId("boot");
    const page = await openSurface(ctx.base, id, { width: 700, height: 420 });

    const result = await page.evaluate(
        ([terminalId]) =>
            new Promise((resolve) => {
                const ws = new WebSocket(`ws://${location.host}/ws?t=${terminalId}&mode=panel&boot=not-the-real-boot-id`);
                ws.onclose = (e) => resolve({ code: e.code });
                setTimeout(() => resolve({ code: ws.readyState === 1 ? "stayed-open" : "unknown" }), 3000);
            }),
        [id],
    );
    ctx.check("stale boot id closed with 4001", result.code, 4001);
    await page.close();
});

group("unknown terminal actions fail cleanly", async (ctx) => {
    const detach = await (await fetch(`${ctx.base}/api/detach?t=does-not-exist`, { method: "POST" })).json();
    ctx.check("detach reports unknown terminal", detach.error, "unknown terminal");
    const attach = await (await fetch(`${ctx.base}/api/attach?t=does-not-exist`, { method: "POST" })).json();
    ctx.check("attach reports unknown terminal", attach.error, "unknown terminal");
});

group("environment is supported", async (ctx) => {
    const state = await (await fetch(`${ctx.base}/api/state`)).json();
    ctx.check("no environment problem reported", state.problem, null);

    const id = uniqueId("shell");
    const page = await openSurface(ctx.base, id, { width: 700, height: 420 });
    ctx.check("running PowerShell 7", (await ctx.state(id))?.shell, "pwsh.exe");
    ctx.check("notice not shown", await page.locator("#notice").isVisible(), false);
    await page.close();
});

// ---------------------------------------------------------------------------
(async () => {
    const { base, external } = await startServer();
    const ctx = new Ctx(base, "");

    try {
        // Learn the prompt so expectations are derived, not guessed.
        const prompt = await measurePrompt(ctx);
        ctx.promptLen = prompt.length;
        ctx.promptText = prompt.text;
        ctx.promptPrefix = prompt.text;
        console.log(`prompt: ${ctx.promptLen} columns`);

        for (const g of groups) {
            if (filter && !g.name.includes(filter)) continue;
            console.log(`\n=== ${g.name} ===`);
            ctx.section(g.name);
            await g.fn(ctx);
        }
    } catch (error) {
        ctx.failures.push(`suite crashed: ${error.stack || error.message}`);
        console.error("\nSUITE ERROR:", error);
    } finally {
        await closeBrowser();
        if (!external) stopServer();
        try {
            rmSync(path.join(os.tmpdir(), "floating-terminal-suite"), { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`${ctx.passes} passed, ${ctx.failures.length} failed`);
    if (ctx.failures.length) {
        console.log("\nFailures:");
        ctx.failures.forEach((f) => console.log(`  - ${f}`));
    }
    process.exit(ctx.failures.length ? 1 : 0);
})();
