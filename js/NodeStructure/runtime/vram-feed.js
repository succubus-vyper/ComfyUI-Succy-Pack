// ============================================================
// NodeStructure/runtime/vram-feed.js — ONE poller for every VRAM display (D-82)
// Before: each Succy Clean VRAM node ran its own setInterval. Now: a single shared poller that
//   - runs only while someone is listening AND at least one listener says it is visible (node not collapsed)
//   - sleeps while the tab is hidden
//   - wakes right after a run ends (the VRAM node's whole point is changing the number)
//   subscribe(fn, isActive?) -> off      last() -> { kind, used, total, pct }      poke()
// kind: "none" (no data yet) · "ok" · "nocuda" · "na" (endpoint down / garbage)
// Succubus was here — she keeps an eye on your reserves. Watching is half the fun.
// ============================================================

const ROUTE = "/succy/vram/stats";
const EVERY_MS = 2000;

const subs = new Map();           // fn -> isActive
let timer = null, pending = false, current = { kind: "none", used: 0, total: 0, pct: 0 }, wired = false;

const A = () => globalThis.app?.api;
const anyActive = () => { for (const act of subs.values()) { try { if (!act || act()) return true; } catch (_) { return true; } } return false; };

function publish(next) {
    current = next;
    for (const fn of [...subs.keys()]) { try { fn(); } catch (e) { console.warn("[NodeStructure] vram-feed subscriber:", e); } }
}

async function fetchOnce() {
    if (pending || !subs.size || document.hidden || !anyActive()) return;
    pending = true;
    try {
        const res = await A().fetchApi(ROUTE);
        if (!res.ok) { publish({ kind: "na", used: 0, total: 0, pct: 0 }); return; }
        const d = await res.json();
        const total = Number(d?.total), used = Number(d?.used);
        if (!Number.isFinite(total) || !Number.isFinite(used) || total < 0 || used < 0) publish({ kind: "na", used: 0, total: 0, pct: 0 });
        else if (total === 0) publish({ kind: "nocuda", used: 0, total: 0, pct: 0 });
        else publish({ kind: "ok", used, total, pct: (used / total) * 100 });
    } catch (_) {
        publish({ kind: "na", used: 0, total: 0, pct: 0 });
    } finally { pending = false; }
}

function start() {
    if (timer || !A()) return;
    timer = setInterval(fetchOnce, EVERY_MS);
    if (!wired) {
        wired = true;
        // a run just ended: the number moved
        for (const ev of ["execution_success", "execution_error", "execution_interrupted"]) { try { A().addEventListener(ev, () => setTimeout(fetchOnce, 400)); } catch (_) {} }
        document.addEventListener("visibilitychange", () => { if (!document.hidden) fetchOnce(); });
    }
    fetchOnce();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

export const VramFeed = {
    subscribe(fn, isActive) {
        subs.set(fn, isActive || null);
        start();
        return () => { subs.delete(fn); if (!subs.size) stop(); };
    },
    last: () => current,
    poke: () => fetchOnce(),
    stats: () => ({ listeners: subs.size, running: !!timer, kind: current.kind }),
};
