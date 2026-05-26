# Icon Design Notes — Pedal Hidrográfico

`web/icon.svg` (rendered to `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`
via `rsvg-convert`). What follows captures the design intent so a future
iteration doesn't lose the thread.

## Concept

A São Paulo watershed seen from above, at night. Two complementary networks
sit on a sea of hills:

- **Rivers** (lime → yellow chain) drain the basin downhill, branching
  fractally from a confluence into a tree of trunks → tributaries → twigs.
- **Ridges** (orange, dashed) are the topographic *dual* of the rivers —
  they form their own branching network in the **inter-fluvial wedges**
  between rivers, and **never cross a river path**. A ridge is an
  *anti-river*: where the river goes down a valley, the ridge runs along
  the divide between two valleys.
- **Hills** are the substance the ridges are made of. Each hill is a
  filled "rotated D" (flat base, half-disc top) placed *on* a ridge path.
  A ridge is read as a chain of hills.
- **Saddles** mark the topological cols where two ridge branches diverge —
  visually a small magenta diamond with two crossed axes (yellow = ridge
  axis, blue = valley axis crossing through). These are the places where
  a hiker could cross from one drainage basin to another without losing
  altitude.

The geographic dual (river network ↔ ridge network ↔ hill chains) is the
core idea. The icon reads like a stylized fragment of a topographic map.

## Palette

```
Background:    #000000   solid black (night sky / void)
Rivers fill:   linear gradient  #a8d62a  →  #d9d83a  →  #f5d028
                                  lime       chartreuse   yellow
Chain dots:    #fff8c8   cream / pale yellow
Ridges:        #d24e15   warm orange
Ridge accent:  #ffba80   peach (sand-light highlight)
Hills:         #d24e15   same orange as ridges (unifies the high-ground network)
Hill outline:  #ffba80   peach (separates hill silhouettes from each other)
Saddles:       #ff4d7c   hot magenta (deliberate contrast vs warm palette)
Saddle axis:   #5a2810   dark brown (background axis line for the saddle X)
```

The black background lets the rivers glow and the orange ridges feel like
lit ground. The magenta saddles are the only cool note in an otherwise warm
palette, so they pop as accents.

## Composition rules

- **Asymmetric, fractal.** Branches at all levels — trunks → main forks →
  tributaries → twigs reaching the edges. No radial symmetry. No central
  focal element (no chainring, no compass).
- **Multiple river systems.** A main basin opens to the SW; a smaller
  secondary basin opens to the E. Their inter-basin divide is one of the
  ridges.
- **Ridges occupy negative space.** They thread *between* river branches.
  When designing a new layout, the rule is: never let an orange path touch
  a green path.
- **Hills sit on ridges.** Each hill is placed so its base is on a ridge
  segment. The cumulative effect is "ridges look like crests of hills"
  rather than "ridges and hills are separate features."
- **Saddles at ridge branching points.** Where one ridge bifurcates into
  two sub-ridges, a saddle marker is placed. Geographically: the col
  between two summits, also the watershed divide for two adjacent basins.

## File / render pipeline

```
icon.svg  ──(rsvg-convert)──┬─► icon-512.png       (PWA / Android large)
                            ├─► icon-192.png       (PWA / Android medium)
                            └─► apple-touch-icon.png  (iOS, rendered 180×180)
```

Re-render after editing the SVG:

```sh
cd web
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 180 -h 180 icon.svg -o apple-touch-icon.png
```

Then bump `web/sw.js`'s `VERSION` so the service worker invalidates the
cached old icon.

## Things worth resisting

- **Don't add a center mark** (gear, logo, anchor). Earlier iterations
  used a chainring/sprocket as a focal point; it turned the icon into a
  snowflake and pulled the eye away from the watershed network.
- **Don't restore the earth gradient** with the black background — the
  contrast between lime rivers and black ground is the whole point.
- **Don't make the network symmetric.** Real watersheds are asymmetric;
  symmetry reads as ornament, not geography.
- **Don't let ridges cross rivers.** Geographically wrong and visually
  muddies the dual-network reading. If two paths must cross (because of
  layout constraints), insert a saddle marker at the crossing.
- **Don't use stroke `dasharray` shorter than ~14px on ridges** at large
  sizes — the dashes blend into a solid line, losing the chain texture
  that distinguishes ridges from rivers.

## Iteration history

| version | change                                                              |
|---------|---------------------------------------------------------------------|
| v1      | initial: SP sunset + skyline + bicycle + energy bolt                |
| v2      | drainage basin + chainring center, radial symmetry                  |
| v3      | dropped chainring, broke symmetry, kept brown/blue palette          |
| v4      | palette → orange ridges + lime/yellow rivers, magenta saddles       |
| v5      | more fractal branching, multi-level tributaries                     |
| v6      | dropped contour-line background; peaks → filled domes ("rotated D") |
| v7      | added "sea of hills" — many small hill bumps scattered as terrain   |
| v8      | ridges repositioned to *not cross rivers* (true topo dual)          |
| v9      | hills relocated *on* ridges; background → solid black               |

## Where the SVG lives

[`web/icon.svg`](web/icon.svg) — single source. Renders are committed in
`web/` so PWA installs don't require a build step.
