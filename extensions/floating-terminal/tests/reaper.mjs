// The reaper: a terminal whose surfaces all disconnect must be disposed, and a
// reconnecting surface must rescue it first.
import { openSurface, closeBrowser, uniqueId, runCommand } from "./helpers.mjs";

const base = `http://127.0.0.1:${process.argv[2]}`;
const GRACE = Number(process.argv[3] ?? 90000);

const list = async () => (await (await fetch(`${base}/api/state`)).json()).terminals;
const has = async (id) => (await list()).some((t) => t.terminalId === id);

let failures = 0;
const check = (label, actual, expected) => {
    const ok = actual === expected;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}: ${actual} (want ${expected})`);
};

// 1. Disconnect and stay away -> reaped.
const gone = uniqueId("reap");
let page = await openSurface(base, gone, { width: 700, height: 420 });
await runCommand(page, "echo HI", 1500);
check("terminal exists while attached", await has(gone), true);
await page.close();
check("still there right after disconnect", await has(gone), true);
console.log(`  waiting ${GRACE + 4000}ms for the reaper...`);
await new Promise((r) => setTimeout(r, GRACE + 4000));
check("reaped after the grace period", await has(gone), false);

// 2. Reconnect within the grace period -> rescued.
const kept = uniqueId("keep");
page = await openSurface(base, kept, { width: 700, height: 420 });
await runCommand(page, "echo KEEP", 1500);
await page.close();
await new Promise((r) => setTimeout(r, Math.min(3000, GRACE / 2)));
page = await openSurface(base, kept, { width: 700, height: 420 });
await new Promise((r) => setTimeout(r, GRACE + 4000));
check("survives while a surface is attached", await has(kept), true);
await page.close();

await closeBrowser();
console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
