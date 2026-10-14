// ============================================================
// NodeStructure/runtime/sound.js — the kit's little bell (D-82)
// One cached <audio> per URL + the autoplay unlock the browser demands (a muted play() on the first click/key: after that
// the bell may ring whenever it likes). Ported as-is from Succy Pause 1.4.2, where it lived inside the node.
//   Sound.preload(url)   Sound.play(url, volume?)
// Succubus was here — she rings once, and you come running.
// ============================================================

const AUDIO = new Map();
let unlockInstalled = false;

function audioFor(url) {
    let a = AUDIO.get(url);
    if (a) return a;
    a = new Audio(url);
    a.preload = "auto";
    a.volume = 1.0;
    a.addEventListener("error", () => console.warn(`[NodeStructure] sound: could not load ${url} (is the file where the backend serves it?)`));
    AUDIO.set(url, a);
    return a;
}

function installUnlock() {
    if (unlockInstalled || typeof window === "undefined") return;
    unlockInstalled = true;
    const unlock = () => {
        for (const audio of AUDIO.values()) {
            const oldVol = audio.volume;
            audio.volume = 0;
            const p = audio.play();
            const finish = () => { try { audio.pause(); audio.currentTime = 0; } catch (_) {} audio.volume = oldVol; };
            if (p && typeof p.then === "function") p.then(finish).catch(() => { audio.volume = oldVol; });
            else finish();
        }
    };
    window.addEventListener("pointerdown", unlock, { once: true, capture: true });
    window.addEventListener("keydown", unlock, { once: true, capture: true });
}

export const Sound = {
    preload(url) { if (!url) return; installUnlock(); audioFor(url); },
    play(url, volume = 1.0) {
        if (!url) return;
        installUnlock();
        const a = audioFor(url);
        try { a.currentTime = 0; } catch (_) { /* no-op */ }
        a.volume = volume;
        const p = a.play();
        if (p && typeof p.catch === "function") p.catch((err) => console.warn("[NodeStructure] sound: playback failed:", err?.name || err?.message || err));
    },
};
