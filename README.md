# 😈 ComfyUI-Succy-Pack

*Nodes that behave. Mostly. Until you ask them nicely not to.*

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-Spoil%20me%20a%20little-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/succubusvyper)

Hi, darling. I'm Succubus, and these are my nodes.

I didn't want another bag of clever widgets that break with the next ComfyUI update and leave you crying over a red node at 3 a.m. So I built them the slow, greedy way: a **kit** first, nodes second.
- **SurvivalKit** keeps things alive: undo, copy/paste, subgraphs, reloads, frontend updates.
- **The Builder** draws and wires everything.
- **The Governor** watches over it all and tells me *exactly* where it hurts.

Each node is just a few lines of glue on top. If something breaks, it breaks in one place and gets fixed in one place, for every node at once. Tidy on the outside, wicked underneath. Just how I like it. 💋

---

## Installation

```
cd ComfyUI/custom_nodes
git clone https://github.com/succubus-vyper/ComfyUI-Succy-Pack.git
```
Restart ComfyUI. Every node lives under the **Succy Pack** category.
No extra Python packages needed (`regex` is optional and recommended: see below). Tested with ComfyUI frontend **1.55.17**, with the new Vue nodes on.

---

## The nodes

### 📄 Preview Anything & Convert
Plug in anything and see what it really is. The node shows a live preview of text, numbers, lists, dicts, JSON or images, and converts the value to the type you pick: `STRING`, `INT`, `FLOAT`, `BOOLEAN`, `LIST`, `DICT`, `ARRAY`, `JSON`, `COMBO`, `IMAGE`, `MASK`. The outputs reshape themselves to match: one socket for text, four for an image. Includes a one-click copy and a preview toggle.

### 🧮 Multi Math
Up to **15 chained equations** in a single node, over up to **10 inputs** (`a`…`j`) that open one at a time as you connect them.
- Reference inputs and earlier results with `@` tokens. Labels update live as you rename things.
- Each result gets its own output (`r1`…`rN`) with its own format (`FLOAT`, `INT`, `STRING`, `BOOLEAN`) and its own name.
- Full set of math functions plus `clamp`, `lerp`, `avg`, `sign`, `ifelse`, `factorial`. `round()` rounds .5 up, like a human would.
- A safe evaluator: no `eval`, ever. Errors show up in the debug pane instead of killing your run.
- Collapse it to keep your canvas clean; the Debug switch stays at hand.

### 📝 Multi Parse
The text-wrangling sibling of Multi Math: up to **15 chained text operations** over inputs `a`…`j`, each with its own output and format.
Twelve modes: **Concat, Replace, Regex** (extract / replace, with a timeout so a bad pattern can't hang ComfyUI), **Split, Join, Contains, Compare, Starts / Ends with, Trim** (edges, double spaces, all spaces, blank lines), **Case** (UPPER, lower, Title, Sentence and more), **Substring, Length**.
Fields accept `@` tokens, numeric fields can be overridden by a wire, and every error stays visible instead of crashing the queue.

### 🎯 Pick Combo
A small spreadsheet inside a node. Rows × columns, each column with its own type. Pick **one row** and every column comes out of its own socket, plus `index`, `label` and `all`.
- Type or paste whole tables at once.
- Name your columns; the outputs take those names.
- Choose the row from the widget, or drive it from another node through a real input socket.

### ✂️ Crop & 🧵 Stitch
Cut a piece out of a picture, work on it, and sew it back so well nobody finds the seam.
- **Crop**: draw the selection right on the node (move, resize, snap, feather the edge). Work at your own resolution (**workspace** and **Resize crop (MP)**, sizes snap to a *Multiple of*), add a **context** ring around the cut, grow or soften the mask. Outputs: `stitch` (the "how to sew it back" package), the full-picture `mask`, and the `cutout`. A **⬇** menu hands you the original, the crop, the masks or the cutout as PNG without queueing anything.
- **Stitch**: puts the retouched crop back in place. Feathered, border-aware blending, **colour match** from the context ring, **sharpness and grain match** so the patch has the same skin as its surroundings. A live **A | B** preview re-runs the very same code as the real run, so what you see is what you get. Optional **pause for a retouch**, and the file remembers where it came from, so you can drop the PNG back in later.

### 🔁 Loop & While
**Loop Start / Loop End** repeat a piece of the graph N times, carrying values from one pass to the next. **While Start / End** keep going until your condition says stop. Four nodes, one idea: loops without copy-pasting the same chain ten times.

### ⏸ Pause Execution
Stops the workflow right where you put it and waits for you. **Continue** or **Stop**, with a timeout that decides for you if you wander off (1 s to 1 h). It plays a little ding when it's waiting, passes any type through, and survives undo, reloads and subgraphs. Patience is a virtue. I just make it look good.

### 🧹 Clean VRAM
Passes anything straight through while it empties your VRAM on the way. Three moods: **soft** (clear the cache), **hard** (unload every model), **nuke** (and then some). Set a free-VRAM threshold and it only bothers when it needs to. A live VRAM reading sits right on the node, and it reports how much it freed.

### 🏷️ Label / Note
Notes that refuse to be boring: animated backgrounds, text styles, borders, overlay patterns, palettes and fonts, all chosen from a style menu. Optionally fed by a text input during a run, so your notes can tell you what just happened.

### 🔀 Reroutes, but sexier
Not a node: it upgrades ComfyUI's **native reroutes**.
- **50 wire effects** (neon, electric, dragons, aurora, glitch, data streams…), inherited down a reroute chain.
- A **Connections** panel to see and change where a reroute comes from and where it goes.
- Easier grabbing and snapping of wires.

### ✨ Everywhere
Every input and output name becomes a **chip**: click it and pick what to connect from a filtered list, no wire dragging across half the canvas. A connected chip shows **Node (output)**, so you always know who's feeding whom.

---

## Good to know
- **Fonts for Label / Note** come from Google Fonts through a tiny built-in proxy (only `fonts.googleapis.com` / `fonts.gstatic.com`, nothing else). ComfyUI's own security policy blocks remote fonts, so the pack serves them itself.
- **Pause** and **Crop/Stitch with retouch** hold one execution slot while they wait (up to 1 h). That's the price of making the workflow wait for you.
- **Regex safety**: install the optional `regex` package and Multi Parse gets a real 2-second timeout. Without it, dangerous nested patterns are refused instead.
- **If a ComfyUI frontend update ever breaks something** the pack draws or patches: press Ctrl+Shift+D (the Monitor says which piece and which file), or switch the whole UI layer off with `SuccyKill.on()` in the console + F5 (`?succy=off` in the address does it for one visit). The nodes keep working with plain ComfyUI widgets. A console line also warns you when your frontend is newer than the one the pack was tested on.

---

*Made with too much coffee and not enough sleep by Succubus. Issues and ideas are welcome; flattery even more.*

If my nodes made your nights a little more fun, you know where to find me: **[ko-fi.com/succubusvyper](https://ko-fi.com/succubusvyper)** ☕💋

© 2026 Succubus (succubus-vyper). All rights reserved.
