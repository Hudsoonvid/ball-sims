# ball-sims

Cool ball simulations that are customizable.

## Hue Swarm

Up to tens of thousands of coloured balls. **Similar colours attract and opposite colours repel**, so a random scatter sorts itself into rainbow blobs, then comets, then a full colour wheel.

Open `index.html` in any modern browser. There's no build step and nothing to install. It runs offline too, and works on phones and tablets.

### Controls

| Section | What you can change |
| --- | --- |
| **Balls** | Number of balls (100–30 000 on the slider, up to 50 000 typed in), ball size, smooth rainbow or 2–12 distinct colours, **🔀 Randomize** (scatter every ball to a new spot), 🎨 shuffle colours, 🎯 follow one ball |
| **Rules** | Checkboxes: similar colours attract · opposite colours repel · similar colours repel · opposite colours attract · balls collide · walls · pull towards the centre. Plus the *colour tolerance*, i.e. how close two hues must be to count as "similar" or "opposite" |
| **Strength** | Attraction strength, repulsion strength, interaction range (short ↔ global), centre pull, friction, jiggle (random motion), simulation speed |
| **Mouse & touch** | Moving over the balls affects everything inside a circle: **Push**, **Pull**, **Swirl**, **Stir** (drag balls along) or Off. Area size and strength are adjustable. Optionally only acts while the button is held |
| **Display** | 3D-shaded balls, glow, motion trails |
| **Presets** | 🌈 Rainbow ring · 🫧 Colour blobs · 🪱 Rainbow worms · ☄️ Comet · 💥 Supernova · 🎯 3 teams · 💞 Opposites attract · 🎱 Billiards |

Keyboard: <kbd>Space</kbd> pause · <kbd>R</kbd> randomize · <kbd>F</kbd> follow a random ball · <kbd>C</kbd> shuffle colours · <kbd>H</kbd> hide the panel · <kbd>Esc</kbd> stop following.
Double-click (or double-tap) a ball to follow it. Settings are remembered between visits.

### How it works

* **The rule.** Hue distance `d` is the fraction of the colour wheel between two balls (0 = same, ½ = opposite). With tolerance `τ`, similarity is `max(0, 1 − d/τ)` and "oppositeness" is `max(0, 1 − (½ − d)/τ)`. Each checked rule adds `±strength × that amount` to the pull between the pair. The force fades with distance as `1 / (1 + r²/ℓ²)`, where `ℓ` is the interaction range.
* **Fast enough for 10 000+ balls.** Summing every pair would be 50 million interactions per frame. Instead, nearby pairs are summed exactly on a spatial grid (that pass also resolves collisions). Distant crowds are lumped together on a multi-level grid, a flat quadtree, that stores per-cell sums of each ball's hue as an angle. The colour rule is expanded as a short Fourier series so it can be applied to a whole cell at once. The grid is shifted randomly every step so its cell borders never leave visible seams.
* **Rendering.** WebGL draws every ball as one point sprite in a single draw call (with a Canvas 2D fallback).

Files: `index.html` (page and panel), `style.css`, `js/sim.js` (physics), `js/renderer.js` (drawing), `js/main.js` (UI, input, presets, main loop).

On a typical laptop, 10 000 balls take about 10 ms per physics step. If things get sluggish, lower the ball count or the simulation speed.
