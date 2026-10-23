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
*A viewer, a video trimmer, a frame extractor, an audio cutter and a format converter. One body, many talents.* 😏
Plug in anything and see what it really is: text, numbers, lists, dicts, JSON, images, masks, **videos and audio**. Convert starts as the type coming in (an INT stays an INT, a MASK stays a MASK, nothing gets converted behind your back); pick another type to convert. The outputs reshape themselves to match: one socket for text and for a single picture, four for a batch, a list or a video (`output`, `selected`, `audio`, `duration`).
- **🎬 Video trimmer**: a player with a **timeline** under it. Drag the green and red handles to keep only the piece you want, or set Start / End / Current in seconds *and* frames — drag them, step with ‹ › (exactly one frame) or type them. Nothing outside the clip is accepted, Current never wanders outside the piece you keep, and ▶ loops your selection until you're satisfied. Start green, End red, Current yellow: even half asleep you know who's who.
- **🖼️ Frame extractor**: `selected` hands out the frame under the yellow Current marker (or the picture you picked in a gallery) as a real IMAGE. Scrub, stop, there's your still. Only decoded when `selected` is actually wired, because I don't do work nobody asked for.
- **🔄 Format converter**: Convert To *is* the container. It starts as the format the video already is; pick **mp4, webm, mkv, mov, avi or gif** and `output` is a real file in that format, not a renamed one. **Split audio** strips the sound from `output` and gives it to you on its own `audio` socket. `duration` tells you how long `output` lasts (seconds, 3 decimals).
- **🎧 Audio**: a compact player with its **waveform**, the same timeline (10 ms steps), `output` = just the piece you kept, `duration` = how long it is, and Convert To picks the format your download comes out in: **wav, mp3, flac, ogg, m4a**.
- **Download** saves the picture, or exactly what `output` is — trimmed, converted, undressed of its audio if you asked.
- **Sizes that make sense**: text = the blue handle sets the height · picture / video = stretch the node, only the picture grows (the timeline stays compact at the bottom) · audio = a slim strip, only the width changes.
- **Everything you see is saved in the workflow**: the text, the numbers, the trim. Reopen an old workflow and it's all still there, right where you left it. Pictures and clips live in ComfyUI's temp folder: after a restart they say *Expired* until the next Run. Decoding a video into frames stops at ~4 GB with a clear message (make the selection shorter — greedy is cute, but not *that* greedy).
- **🎞️ Batches that are videos**: a batch of frames from *any* node (Wan, AnimateDiff, LTX, an upscale pass…) gets the same player and timeline. **As clip** · *Auto* decides from how the frames move (a sliding sequence = a clip, seed variants = pictures), *On* forces it, *Off* shows pictures. As a clip, out come the frames you kept (untouched if you don't trim) plus `selected`, `audio` and `duration`.
- **fps · AUTO · EXT**: the clip's fps fills itself from what arrives — the video's own, a VHS loader's, otherwise 24 — and the info line says where it came from. **AUTO** lit = automatic and locked; click it to unlock the field, type your own and press **APPLY**: the clip is re-timed right away, no Run needed (on a VIDEO: same frames, another speed). **EXT** opens an `fps_override` input so a wire can decide.
- **🔉 Two volumes**: **Out vol** is how loud the sound you *save* and send on is (applied on Run — and the player plays it, so you hear what you get); **Listen** is only how loud *you* hear it in the box, never saved. With **Split audio** the player goes silent too.
- **🔊 Your own soundtrack**: plug something into the optional `audio` input and it becomes the clip's sound, replacing the one it had (cut to the clip's length).
- **🖼️ Gallery**: a batch shown as pictures shows **all of itself**, 12 per page — the thumbnails arrive one by one while you already look at the first ones, and the line below counts them in. Click one to see it big: **‹ ›** (or the arrow keys) for previous / next, **▦** back to the grid, and **⬇** downloads *that* frame at full size. A VIDEO with *As clip Off* gives its frames as an IMAGE batch, with the gallery.
- **🎥 VHS friendly**: plug the `IMAGE` of a VHS *Load Video* and I read the loader's settings myself — you get the clip with its timeline and its sound, and out come the frames you kept plus `audio`, `frame` and `duration`, already cut to the same window. VHS's audio on its own works too, and *Video Combine*'s Filenames play as a real video. No extra wires, no converter nodes.
- **Quiet console**: nothing is dumped into ComfyUI's console on every run. Want the old `PreviewAny` printout back? Start ComfyUI with the environment variable `SUCCY_PREVIEW_LOG=1`.

### 🧮 Multi Math
Up to **15 chained equations** in a single node, over up to **10 inputs** (`a`…`j`) that open one at a time as you connect them.
- Reference inputs and earlier results with `@` tokens. Labels update live as you rename things.
- Each result gets its own output (`r1`…`rN`) with its own format (`FLOAT`, `INT`, `STRING`, `BOOLEAN`) and its own name.
- Full set of math functions plus `clamp`, `lerp`, `avg`, `sign`, `ifelse`, `factorial`. `round()` rounds .5 up, like a human would.
- A safe evaluator: no `eval`, ever. Errors show up in the debug pane instead of killing your run.
- Collapse it to keep your canvas clean; the Debug switch stays at hand.

### 📝 Multi Parse
The text-wrangling sibling of Multi Math: up to **15 chained text operations** over inputs `a`…`j`, each with its own output and format.
Eleven modes: **Concat** (default / template), **Replace, Regex** (extract / replace, with a timeout so a bad pattern can't hang ComfyUI), **Split, Contains, Compare, Starts / Ends with, Trim** (edges, double spaces, all spaces, blank lines), **Case** (UPPER, lower, Title, Sentence and more), **Substring, Length**.
Fields accept `@` tokens, numeric fields can be overridden by a wire, and every error stays visible instead of crashing the queue.
**Concat · Default** is a plain concat: every wired input glued with the separator you type, exactly as typed (empty = a space, `\n` or `/n` = new line; lists count as their items; *Trim pieces* trims the inputs, never the separator, and drops the empty ones, no `a, , c`). Flip it to **Template** for `Hello @a, you are @b`. Images on an input show up as `<tensor 4x512x512x3>`, not a wall of numbers.

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
- **list**: every item in one list. Numbers and text = ONE list value; pictures and masks = ComfyUI's own image / mask list (an "image list" node takes it whole, any other node runs once per picture); latents, prompts, sound and models have no list (use **batch**). **batch**: everything glued into one batch (IMAGE, MASK, LATENT, AUDIO, and CONDITIONING = one prompt per picture); it simply disappears for types that can't batch. **count**: how many.
- **Lazy**: with only `picked` wired, the branches she doesn't pick never run.
- Advanced (folded): **From / To / Every** pick which items list/batch/count keep (numbers, each one also from a wire), **Fit** (stretch / crop / pad) and **Size of** (first / largest / smallest) for pictures of different sizes in a batch (list never resizes). ⇅ slides the plugged inputs up over the holes and renumbers them.

### 🎯 Pick Combo
A small spreadsheet inside a node. Rows × columns, each column with its own type. Pick **one row** and every column comes out of its own socket, plus `index`, `label` and `all`.
- Type or paste whole tables at once.
- Name your columns; the outputs take those names.
- Choose the row from the widget, or drive it from another node through a real input socket.

### ✂️ Crop & 🧵 Stitch
Cut a piece out of a picture, work on it, and sew it back so well nobody finds the seam. I like my secrets well hidden.
- **Crop**: draw the selection right on the node (move, resize, snap, feather the edge), or switch to **Brush** and paint it. Work at your own resolution (**workspace** and **Resize crop (MP)**, sizes snap to a *Multiple of*), add a **context** ring around the cut, grow or soften the mask. Outputs: `stitch` (the "how to sew it back" package), the full-picture `mask`, and the `cutout`. A **⬇** menu hands you the original, the crop, the masks or the cutout as PNG without queueing anything.
- **Bend the box (perspective)**: **Ctrl / ⌘ + a corner** moves only that corner, grab just outside a corner to **rotate**, double-click a corner to put it back. A tilted cut stays tilted in the cutout, and Stitch puts it back exactly where — and how crooked — it was. Same box, same tricks, in **Load Image & Resize** too.
- **Stitch**: puts the retouched crop back in place. Feathered, border-aware blending, **colour match** from the context ring, **sharpness and grain match** so the patch has the same skin as its surroundings. A live **A | B** preview re-runs the very same code as the real run, so what you see is what you get. Optional **pause for a retouch**, and the file remembers where it came from, so you can drop the PNG back in later. Something missing? The preview tells you exactly which input and why.
- **Two moods in Stitch**: **Edit Mask** (the hole: feather, opacity, blend mode, curve, and **◇ Free Edit Mask** to bend the hole by its corners) and **Edit Item** (the piece: colour, sharpness, grain, offset, scale, and **◇ Free Edit Item** — four corners, one perspective, Photoshop-style: inside = move, corner = scale, Shift = keep proportions, Alt = from the centre, Ctrl = one corner alone, just outside = rotate). Corners refuse to fold over themselves, so nothing ever vanishes on you.
- **A brush that knows what you want**: hold **Ctrl** and the brush becomes the eraser (and the eraser the brush), even mid-stroke. **✒ Pen pressure** for drawing tablets: press lightly for a fine tip, harder for a fat one. Soft hardness really is soft.
- **Move around like you own the place** (every Crop, Stitch and Load view): wheel = zoom, middle button or **Ctrl + Alt + drag** = pan, **Ctrl + Shift + drag** = zoom (perfect with a pen). Or click **✋** / **🔍** on the left to lock pan or zoom. Forgot a key? **I** shows the keys for what you're doing right now, **I** again hides them.
- **Every gesture is one Ctrl+Z.** A whole brush stroke, a whole corner drag: one step back, instantly, no reload.

### 🖼️ Load Image & Resize
One loader that also resizes, and shares what it holds with the rest of the pack **live**, no Queue.
- **Image**: drop / paste / 📂 a picture (or wire one in) and draw the mask right on it — box and brush, grow, feather, like Crop. Nothing drawn = an empty mask, like ComfyUI's Load Image; the picture's own transparency counts as mask too.
- **A mask on the wire is a starting point, not a cage**: it becomes the base, and the box, the brush (paint *and* erase), grow and feather keep working on top of it — and if it comes from another live Succy node, you see it on the picture right away.
- **Folder**: the input folder, one of its subfolders, or any full path. **Next** hands out the following picture at every execution — a Run, a ▶ of a **Pause** — and `is_last` turns true on the last one. Inside a **While**, use **Pick one**: wire the While Start's `value0` into Index Pick (that wire is what puts the Load inside the loop) and `is_last` into the stop condition (`b != True`). A strip of thumbnails shows where you are; click one to go on from there (or to pick it, in **Index** mode).
- **Resize** moves picture and mask together, so they always match (handy before a second sampler or an inpaint): **W × H** with Fit / Fill / Pad / Stretch, an anchor and an **Outpaint** switch for the borders, or **Scale** (megapixels, then scale by). Sides snap to a *Multiple of* (1 = untouched).
- **Live**: any Succy node wired to it — Stitch's replacement, base or mask, Crop's image or mask, Any — sees the picture right away, and follows when you change it. **Edit mask** shows the picture you're drawing on; **Result** shows what leaves the node (resized, mask and all).

### 🔁 Loop & While
**Loop Start / Loop End** repeat a piece of the graph N times, carrying values from one pass to the next. **While Start / End** keep going until your condition says stop. Four nodes, one idea: loops without copy-pasting the same chain ten times.

### ⏸ Pause Execution
Stops the workflow right where you put it and waits for you. **Continue** or **Stop**, with a timeout that decides for you if you wander off (1 s to 1 h). It plays a little ding when it's waiting, passes any type through, and survives undo, reloads and subgraphs. While it waits it behaves exactly like the **Global pause** below: coloured borders, and whatever you change counts when you press **Continue** (or the ▶ in the top bar) — no restart. Inside a started Loop / While your edits wait for the next Run. Patience is a virtue. I just make it look good.

### ⏸ Global pause (top bar)
Not a node: the ⏸ at the head of the progress bars holds the **whole run** between two nodes. The node at work always finishes (a KSampler ends its steps), then everything waits for you, and the borders tell you what an edit will do: **green** = still to run · **amber** = already through, but something still to run reads it, so a changed value runs again *now* · **red** = done, a change waits for the next Run. **▶** goes on, **Stop** ends it.
- **Change your mind while it waits**: edit any value and press ▶. A green node takes the new value in this very run. An amber node runs again *now* — flip a Bool or an Any switch and the conditioning, latent, number or picture behind it is swapped before the sampler starts. Any type, inside subgraphs too.
- **What waits for the next Run**: red nodes (nothing still to run reads them), moved / added / removed wires on amber or red nodes, new nodes.
- **A started Loop / While is a closed world**: once it has begun, everything inside it counts as through (red). To stop *inside* a loop, use the **Pause Execution** node.
- Want to know what ▶ did with your edits? Settings → Monitor → **Pause log**: one short line in the console. Off by default, because nobody likes a chatty partner.

### 🧹 Clean VRAM
Passes anything straight through while it empties your VRAM on the way. Three moods: **soft** (clear the cache), **hard** (unload every model), **nuke** (and then some). Set a free-VRAM threshold and it only bothers when it needs to. A live VRAM reading sits right on the node, and it reports how much it freed.

### 🏷️ Label / Note
Notes that refuse to be boring: animated backgrounds, text styles, borders, overlay patterns, palettes and fonts, all chosen from a style menu. Optionally fed by a text input during a run, so your notes can tell you what just happened.

### 🔀 Reroutes, but sexier
Not a node: it upgrades ComfyUI's **native reroutes**.
- **50 wire effects** (neon, electric, dragons, aurora, glitch, data streams…), inherited down a reroute chain.
- A **Connections** panel to see and change where a reroute comes from and where it goes.
- Easier grabbing and snapping of wires.

### 🖱️ Right-click, darling
Not a node: a few extra treats on top of ComfyUI's **right-click on the empty canvas**. ComfyUI's own menu stays exactly where it was, just under mine. 💋
- **▶️ Queue** when nothing is running — and the moment something runs it turns into **🛑 Force Stop Queue**: the queue is wiped and the job is interrupted. A custom node that ignores the polite stop gets the interrupt thrown *inside* its own thread; if it's stuck somewhere nothing can reach (one endless GPU call), I tell you so and offer a reboot. No more killing the whole console window.
- **✨ Free VRAM — soft**: empties the CUDA cache, your models stay loaded. A quick breath, usually a little room. **🔥 Free VRAM — unload all**: every model out, cache dropped, a clean bed. Both tell you how many GB they freed.
- **⏻ Reboot ComfyUI**: restarts the server **in the tab you're in** — no new browser tab popping up every time. The tab waits, and reloads itself the moment ComfyUI is back, even if you wandered off to another tab meanwhile. It asks first only if there's something in the queue. (ComfyUI Desktop uses its own restart.)
- **💎 Succy - Primitive** and **📄 Succy - Preview**: dropped right where you clicked. Because some things are needed *all the time*.

### ✨ Everywhere
Every input and output name becomes a **chip**: click it and pick what to connect from a filtered list, no wire dragging across half the canvas. A connected chip shows **Node (output)**, so you always know who's feeding whom.

---

## Good to know
- **Fonts for Label / Note** come from Google Fonts through a tiny built-in proxy (only `fonts.googleapis.com` / `fonts.gstatic.com`, nothing else). ComfyUI's own security policy blocks remote fonts, so the pack serves them itself.
- **Pause** and **Crop/Stitch with retouch** hold one execution slot while they wait (up to 1 h). That's the price of making the workflow wait for you.
- **Load Image & Resize, Folder mode**: a full path can point anywhere on the computer that runs ComfyUI (like other folder loaders). Its thumbnails route only answers ComfyUI's own page and only with picture files of that folder.
- **Live link**: Succy nodes ask each other for a reduced picture while you edit; the full size is computed only on Run, Copy and Download. Primitive (Image / Mask), Any, Load, Crop and Stitch send; Crop, Stitch, Load, Any and Preview receive. **Empty → Block** needs a ComfyUI that has `ExecutionBlocker` (anything recent); otherwise it hands out nothing, as in the plain mode.
- **Regex safety**: install the optional `regex` package and Multi Parse gets a real 2-second timeout. Without it, dangerous nested patterns are refused instead.
- **Reboot from the menu** relaunches ComfyUI with the same command line plus `--disable-auto-launch`, so the browser isn't opened a second time. **Force Stop**'s inside-the-thread interrupt is the same `InterruptProcessingException` ComfyUI uses for its own Stop: the run ends as "interrupted", nothing else is touched.
- **If a ComfyUI frontend update ever breaks something** the pack draws or patches: press Ctrl+Shift+D (the Monitor says which piece and which file), or switch the whole UI layer off with `SuccyKill.on()` in the console + F5 (`?succy=off` in the address does it for one visit). The nodes keep working with plain ComfyUI widgets. A console line also warns you when your frontend is newer than the one the pack was tested on.

---

*Made with too much coffee and not enough sleep by Succubus. Issues and ideas are welcome; flattery even more.*

If my nodes made your nights a little more fun, you know where to find me: **[ko-fi.com/succubusvyper](https://ko-fi.com/succubusvyper)** ☕💋

© 2026 Succubus (succubus-vyper). All rights reserved.
