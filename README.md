# Bernd Salomon — Portfolio

A portfolio that is also a walk through a Swedish forest on a summer morning. This version builds on the Opus forest and adds a layer of detail: silver birches close to the walk, young birches in the understory, tinder-fungus brackets, surface roots, dead snags, pebbles, boletes, fallen birch leaves and more dew. The first Fable version (a separate engine) is kept in `archive/fable-v1`.

At the top you look up into the crowns of tall Scots pines and white-stemmed birches while warm sunlight breaks through them. As you scroll, the camera tilts down past the trunks, through shafts of light in the morning mist, into the undergrowth. It ends on the mossy forest floor, where a young oak grows from its acorn in a fleck of sunlight, covered in dew, next to the line **"Let us build something great together."**

Nothing in the scene is a photo or a downloaded model. Every tree, texture, sunbeam and dew drop is generated in real time in the browser with [three.js](https://threejs.org).

## Run it locally

ES modules need a web server (opening `index.html` directly from disk will not work):

```bash
node serve.mjs
```

Then open http://localhost:5173. Any static server works too, e.g. `npx serve` or `python -m http.server`.

## Deploy

There is no build step. Upload the folder as-is to any static host: GitHub Pages, Netlify, Vercel, Cloudflare Pages or your own server.

Everything is served from the site itself, so visitors' browsers contact no third party (no Google Fonts, no CDN). That keeps the privacy policy short and avoids the German Google-Fonts warning letters:

- three.js v0.169.0 (MIT): `vendor/three/three.module.min.js`, wired up through the import map in `index.html`
- Fraunces, Inter and La Belle Aurore (SIL Open Font License): `fonts/`, declared in `css/fonts.css`

## Editing the content

All text lives in **`index.html`**:

| Section | What's there |
| --- | --- |
| Hero | Role line and tagline under the name |
| 01 · About | Personal story, facts (home, focus, how and where I work, languages, status) and the three "How I can help" offerings |
| 02 · Work | Four project cards: title, text, tags, organisation |
| 03 · Experience | Career timeline and the grouped toolkit chips |
| 04 · Contact | E-mail, phone numbers and the Say hej / GitHub / LinkedIn / CV buttons. The CV is `Bernd-Salomon-CV.pdf`; replace that file to update it |
| `impressum.html` | Legal notice (provider, register, VAT). Company details still marked `TODO(AB details)` |
| `privacy.html` | Privacy policy: hosting (GitHub Pages), contact by e-mail/phone, rights. Update the hosting section if the site moves (e.g. to Cloudflare) |

The yin-yang button in the navigation is "just the forest": it fades every word away, leaves a quiet card with name, e-mail and the two phone numbers at the bottom, and lets the walk drift slowly on its own (about four minutes down to the forest floor and back, paused whenever the visitor scrolls). Escape or the button brings the text back; `?zen` opens the page that way.

E-mail addresses (`data-mail="user|domain"`) and phone numbers (`data-tel="prefix|rest"`) in the contact chapter are assembled by `js/ui.js`, so simple scrapers can't harvest them from the HTML. The page `<title>`, meta description and Open Graph tags are at the top of `index.html`.

## Tuning the forest

| File | What it controls |
| --- | --- |
| `js/story.js` | Camera keyframes per chapter (`CAM`) and the look of each chapter (`LOOK`): exposure, haze, god rays, depth of field |
| `js/world/seasons.js` | The four seasons: light, mist, leaf colours, snow, falling leaves and snowfall. The forest opens in midsummer; visitors can change the season with the button in the navigation, and `?season=today` follows the calendar |
| `js/world/layout.js` | Sun height and direction, the camera's walking line, where the sapling grows |
| `js/quality.js` | Rendering budgets for low, medium and high quality (pixel count, shadows, volumetrics, tree count) |
| `js/world/trees.js` | Procedural Scots pine, Norway spruce, silver birch and young understory spruces; hand-placed hero trees and birches along the walk. Old birches are oval and bumpy, bulge under their limbs, often fork and twist their grain; their scars, lichen and smudges are drawn per tree in the bark shader |
| `js/world/sapling.js` | The oak seedling and its growth animation |
| `js/world/plants.js` | Blueberry, lingonberry, ferns, wavy hair-grass, moss tufts and fallen birch leaves |
| `js/world/props.js` | Granite boulders, pebbles, surface roots, fallen logs, stump, dead snags, twigs, pine cones, chanterelles, boletes and fly agarics |
| `js/world/details.js` | Dew drops, the spider web, sunlit dust and the misty forest backdrop |
| `js/post/pipeline.js` | HDR post-processing: volumetric light, crepuscular rays, bloom, depth of field, ACES tone mapping and grading |
| `js/audio.js` | Optional synthesised soundscape: wind and Swedish great tits ("Sound" button, off by default) |

## How it works

- **Textures** (bark, moss, needle litter, granite, dead wood) are painted once on the GPU by a shader into tileable render targets (`js/gl/bake.js`). Needles, leaves, fern fronds and berries are drawn with Canvas 2D (`js/world/foliage-textures.js`).
- **Trees** are generated from a few seeds per species and LOD level, then instanced several hundred times. Foliage cards have their normals bent around the crown volume, and light passes through backlit leaves (translucency). Everything sways in a shared wind.
- **Light**: one sun with a shadow map that follows the camera. The shadow map is ray-marched to produce real light shafts through the canopy, and a screen-space pass adds the rays that break through the crowns around the sun. Height fog scatters warmly toward the sun.
- **Scroll** maps each chapter to a camera keyframe. Exposure, haze, depth of field and the sapling's growth are blended along the way.
- **Performance**: the 3D layer renders at a fixed pixel budget for each quality tier (the HTML stays sharp), and the resolution adapts automatically if frames get slow. Medium quality runs at about 10–15 ms per frame at 1280×800 on an AMD Radeon 890M integrated GPU.
- **Accessibility**: all content is real HTML. The canvas is decorative (`aria-hidden`), `prefers-reduced-motion` is respected, and without WebGL 2, or when the 3D scripts can't be loaded, the page falls back to a static gradient with all content visible.

## Share preview

`og-image.jpg` (1200×630) is the picture LinkedIn, WhatsApp, Slack and others show when the link is shared. It was rendered from the scene itself. After changing it, LinkedIn's [Post Inspector](https://www.linkedin.com/post-inspector/) refreshes their cached preview.

## Debug URL parameters

| Parameter | Effect |
| --- | --- |
| `?debug` | FPS / resolution overlay |
| `?quality=low\|medium\|high\|ultra` | Force a quality tier |
| `?s=0..4` | Pin the camera at a story position (0 = canopy, 4 = forest floor) |
| `?season=0..4` | Start in a season (0.5 spring, 1.5 summer, 2.5 autumn, 3.5 winter); `?season=today` follows the calendar |
| `?clean` | Hide the HTML overlay to look at the scene |
| `?novol` `?noshadow` | Disable volumetric light or shadows |
| `?nodynres` | Disable adaptive resolution |
| `?pixels=1.5` | Pixel budget in megapixels |
| `?noforest` `?noplants` `?noprops` `?nodetails` `?noground` | Remove parts of the scene |

In the console, `forest.bench(8, s)` returns the GPU milliseconds per frame at story position `s`.

## Credits

- [three.js](https://threejs.org) (MIT)
- Noise functions after Stefan Gustavson and Ashima Arts (MIT)
- Fonts: [Fraunces](https://fonts.google.com/specimen/Fraunces) and [Inter](https://fonts.google.com/specimen/Inter) (SIL Open Font License)
