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

## ⚡ Instant. No Queue. No foreplay.

Most pickers make you press the big blue button and *wait* before you may look. Not mine. **My picture nodes are live**: **Load Image & Resize, Primitive (Image / Mask), Any, Crop, Stitch and Preview Anything** talk to each other the moment you plug them in — no Queue, no Run, no "come back later, darling".

- **Plug and it's already there.** Wire a Load into a Crop and the picture is on the Crop's canvas. Wire its mask in and the Crop's veil shows it, right now. Change the Load, and everyone on its wires follows, instantly.
- **Touch it, it moves.** Draw a box, paint with the brush, grow, feather: the result updates under your fingers. Stitch shows its **A | B** blend before you ever press Run.
- **What travels is a light, reduced copy** — enough to look good and feel immediate. **The full-size picture is only computed when you Run, Copy or Download**, so your VRAM keeps its dignity.
- **It follows the whole chain, not just the next node.** Load → Any → Crop → Stitch: each one asks the one behind it, as it is *right now*.
- **Shy nodes say so.** If something upstream can only be known after a Run (a sampler, say), the node tells you exactly what it's waiting for instead of pretending. No guessing, no surprises.
- **"Nothing" is a real answer.** When an Any chooses an empty input, whatever is wired after it behaves exactly as if the cable weren't there. Pull the cable out of the socket without touching the cable. 😈

Run still does the real, full-size, hard work, of course. Live is the foreplay; and I *do* believe in foreplay.

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

### 💎 Primitive
The ultimate primitive. She's born small and undecided: pick what she becomes — **Int, Float, Seed, Bool, String, Multiline, List, Color, Resolution, Image, Mask, Latent** — and she turns into exactly that, with the right controls and outputs. Her title follows (*Succy - 🔢Int*…) unless you renamed her yourself.
- **Or just wire her**: drag her output onto any widget of another node and she copies it, value included. Dropdowns too (sampler, scheduler, models…).
- Open-ended numbers (drag, click to type, ‹ ›), Float **Precision** (1–6 decimals), Seed with ComfyUI's own Fixed / +1 / −1 / Random, 🎲 and ↺ Reuse the last seed.
- Multiline with **Trim** and an output type (STRING, INT, LIST, JSON…); List gives the list and its item count.
- Resolution / Image / Mask / Latent: presets (SDXL buckets included), ⇄ swap, *Multiple of*, **Scale**; width, height and megapixels come out too.
- **Live as Image or Mask**: the picture or mask she makes is already there for every Succy node on her wire — a blank canvas for a Crop, a flat mask for a Stitch — without a Queue.
- Changed your mind? The little **↺** in her title bar, next to the heart, makes her a newborn again. A real node, not a virtual one: subgraphs, copy/paste and the API all work.

### 🕵 Any
Switch, batch and list in one body. Plug anything into her first input and every input locks onto that type, a new one opens each time you plug the last, and her outputs and title follow (*Succy - Any🖼️ Image*…). Unplug everything and she's Any again.
- **picked**: one input, chosen by **Index** (inputs keep their number: unplug 1 and 2 and the 3 is still the 3; `-1` = last), **Bool** (True = input 1, False = input 2) or **Auto** (the first that really arrives: mute a branch and the next one takes over). Index and Bool can come from a wire (**EXT**). The Index grows with your cables — from minus the last plugged one up to the free socket after it — and **0 is "nothing at all"**: the off position.
- **Choosing nothing is a feature.** Pick an empty input (a hole, the free socket, a muted branch, Index 0) and `picked` hands out *nothing*: for any node after it with that input optional, **it is exactly as if the cable weren't there** — an **instant switch for a mask, a control image, a reference**. Plug only input 1 and use **Bool**: True sends the value, False sends nothing — an injector. Prefer the whole branch to stay asleep? **Empty gives → Block** and the nodes after her quietly do nothing (no error, no run).
- **Live**: `picked` and `batch` reach Crop, Stitch, Load and Preview the moment you change the choice, for pictures and masks — flip the Index and watch the veil change, no Queue.
- **list**: every item one by one, for ANY type — three checkpoints, one Run, the sampler tries them all. **batch**: everything glued into one batch (IMAGE, MASK, LATENT, AUDIO, and CONDITIONING = one prompt per picture); it simply disappears for types that can't batch. **count**: how many.
- **Lazy**: with only `picked` wired, the branches she doesn't pick never run.
- Advanced (folded): **From / To / Every** pick which items list/batch/count keep (numbers, each one also from a wire), **Fit** (stretch / crop / pad) and **Size of** (first / largest / smallest) for pictures of different sizes in a batch (list never resizes). ⇅ slides the plugged inputs up over the holes and renumbers them.

### 🎯 Pick Combo
A small spreadsheet inside a node. Rows × columns, each column with its own type. Pick **one row** and every column comes out of its own socket, plus `index`, `label` and `all`.
- Type or paste whole tables at once.
- Name your columns; the outputs take those names.
- Choose the row from the widget, or drive it from another node through a real input socket.

### ✂️ Crop & 🧵 Stitch
Cut a piece out of a picture, work on it, and sew it back so well nobody finds the seam.
- **Crop**: draw the selection right on the node (move, resize, snap, feather the edge). Work at your own resolution (**workspace** and **Resize crop (MP)**, sizes snap to a *Multiple of*), add a **context** ring around the cut, grow or soften the mask. Outputs: `stitch` (the "how to sew it back" package), the full-picture `mask`, and the `cutout`. A **⬇** menu hands you the original, the crop, the masks or the cutout as PNG without queueing anything.
- **Stitch**: puts the retouched crop back in place. Feathered, border-aware blending, **colour match** from the context ring, **sharpness and grain match** so the patch has the same skin as its surroundings. A live **A | B** preview re-runs the very same code as the real run, so what you see is what you get. Optional **pause for a retouch**, and the file remembers where it came from, so you can drop the PNG back in later. Something missing? The preview tells you exactly which input and why (no picture yet, or it needs a Run).

### 🖼️ Load Image & Resize
One loader that also resizes, and shares what it holds with the rest of the pack **live**, no Queue.
- **Image**: drop / paste / 📂 a picture (or wire one in) and draw the mask right on it — box and brush, grow, feather, like Crop. Nothing drawn = an empty mask, like ComfyUI's Load Image; the picture's own transparency counts as mask too.
- **A mask on the wire is a starting point, not a cage**: it becomes the base, and the box, the brush (paint *and* erase), grow and feather keep working on top of it — and if it comes from another live Succy node, you see it on the picture right away.
- **Folder**: the input folder, one of its subfolders, or any full path. **Next** hands out the following picture at every execution — a Run, a lap of a Succy **Loop / While**, a ▶ of a **Pause** — and `is_last` tells the While when the folder is over. A strip of thumbnails shows where you are; click one to go on from there (or to pick it, in **Index** mode).
- **Resize** moves picture and mask together, so they always match (handy before a second sampler or an inpaint): **W × H** with Fit / Fill / Pad / Stretch, an anchor and an **Outpaint** switch for the borders, or **Scale** (megapixels, then scale by). Sides snap to a *Multiple of* (1 = untouched).
- **Live**: any Succy node wired to it — Stitch's replacement, base or mask, Crop's image or mask, Any — sees the picture right away, and follows when you change it. **Edit mask** shows the picture you're drawing on; **Result** shows what leaves the node (resized, mask and all).

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
- **Load Image & Resize, Folder mode**: a full path can point anywhere on the computer that runs ComfyUI (like other folder loaders). Its thumbnails route only answers ComfyUI's own page and only with picture files of that folder.
- **Live link**: Succy nodes ask each other for a reduced picture while you edit; the full size is computed only on Run, Copy and Download. Primitive (Image / Mask), Any, Load, Crop and Stitch send; Crop, Stitch, Load, Any and Preview receive. **Empty → Block** needs a ComfyUI that has `ExecutionBlocker` (anything recent); otherwise it hands out nothing, as in the plain mode.
- **Regex safety**: install the optional `regex` package and Multi Parse gets a real 2-second timeout. Without it, dangerous nested patterns are refused instead.
- **If a ComfyUI frontend update ever breaks something** the pack draws or patches: press Ctrl+Shift+D (the Monitor says which piece and which file), or switch the whole UI layer off with `SuccyKill.on()` in the console + F5 (`?succy=off` in the address does it for one visit). The nodes keep working with plain ComfyUI widgets. A console line also warns you when your frontend is newer than the one the pack was tested on.

---

*Made with too much coffee and not enough sleep by Succubus. Issues and ideas are welcome; flattery even more.*

If my nodes made your nights a little more fun, you know where to find me: **[ko-fi.com/succubusvyper](https://ko-fi.com/succubusvyper)** ☕💋

© 2026 Succubus (succubus-vyper). All rights reserved.
