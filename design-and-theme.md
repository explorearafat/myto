# Teamly AI — Design & Theme System

> Extracted from the five attached screenshots (Chat/Feed, Agents, Memory/Wiki, Artifacts).
> Every hex value below was sampled directly from the images, not guessed.
> This is a **mobile-first, light-only** product with a single loud brand accent: a vivid
> "signal green". Everything else is white space, soft grey chips and black type.

---

## 1. Brand at a glance

| Property | Value |
|---|---|
| Product | **Teamly AI** — personal AI agents + teams, private wiki, artifacts |
| Platform | Mobile app (portrait, ~825 × 1600 px screenshots ⇒ 393 pt logical width) |
| Mood | Calm, clean, "workspace" feel with playful cartoon robot mascots |
| Primary accent | **Signal Green `#00C951`** |
| Base surface | Near-white `#FAFBFD` → pure white cards |
| Type colour | Near-black ink `#111727` |
| Corner language | Very soft — **pill-first**, cards at 20–28 px radius |
| Density | Airy. Large gutters, generous row height, lots of white |
| Theme modes | Light only in these shots (dark mode tokens proposed in §9) |

**The one-line design idea:** *a white sheet of paper, a green highlighter, and friendly
robot colleagues.* Every screen is white; green is reserved for "this is live / this is
active / this is the action"; colour only appears for identity (avatars, topic tiles).

---

## 2. Colour palette (measured)

### 2.1 Brand green family

| Token | Hex | Sampled from | Usage |
|---|---|---|---|
| `--green-500` | `#00C951` | All "Chat" buttons, "Create My Own Agent", selected "All" chip, active tab underline | **Primary action + active state** |
| `--green-600` | `#00B548` | Edge/shadow of green buttons | Pressed button |
| `--green-050` | `#EA FBF1` → `#EAFBF1` | "Agent generated" tag background | Success/agent tag fill |
| `--green-700` | `#18964D` | Active bottom-nav label ("Artifacts"), "Agent generated" text | Green **text** (never `#00C951` for text — too light on white) |
| `--green-link` | `#06A046` | "+ New" link in Memory | Green text link |

> ⚠️ **Most important rule in this system:** `#00C951` is a **fill** colour, not a text
> colour. When green must be text, it drops to `#18964D`. Sampled proof: the active nav
> label is `#18964D`, while the button next to it is `#00C951`.

### 2.2 Neutrals / surfaces

| Token | Hex | Sampled from | Usage |
|---|---|---|---|
| `--bg-app` | `#FAFBFD` | Feed + Artifacts page background | App canvas |
| `--bg-app-alt` | `#F1F4F9` | Memory list background, Agents divider | Secondary canvas / section band |
| `--surface` | `#FFFFFF` | All cards, list rows, search fields | Card / row / sheet |
| `--surface-chip` | `#F5F6FA` | Unselected chips, "My Custom Agents" | Neutral chip / segmented control track |
| `--surface-paper` | `#F1F0EB` | The co-editable brief document body | **"Document" surface** — warm paper, not grey |
| `--surface-tint` | `#F3F4F6` | Hover/pressed row tint | Row pressed state |
| `--divider` | `#EEEEEE` | Hairlines under nav / between groups | 1 px separators |

### 2.3 Ink (text)

| Token | Hex | Sampled from | Usage |
|---|---|---|---|
| `--ink-900` | `#111727` | Feed headline, "Teamly AI" title | Headings, titles |
| `--ink-800` | `#191919` | Artifacts "Animated Science Short" | Card titles (neutral variant) |
| `--ink-700` | `#3A4149` | Feed sub-headline | Long-form body copy |
| `--ink-500` | `#6B7280` | Row descriptions ("Expert content strategist…") | Secondary text |
| `--ink-300` | `#B9BABE` | Placeholder / empty search ("Search posts, creators…") | Placeholder, timestamps, counts |
| `--ink-teal` | `#355F55` | "WEEKLY INDUSTRY BRIEF · TECHNOLOGY & SOFTWARE" | Editorial eyebrow / kicker |

### 2.4 Identity accents (Memory topic tiles only)

| Token | Hex | Tile |
|---|---|---|
| `--accent-pink` | `#EB4899` | Overview |
| `--accent-cyan` | `#07B6D5` | My Profile |
| `--accent-amber` | `#FACC15` | Next Actions |
| `--accent-violet` | `#A755F7` | My Artifacts |
| `--accent-green` | `#00C951` | Getting Started (implied brand tie-in) |

### 2.5 Avatar / illustration pastels

| Token | Hex | Used on |
|---|---|---|
| `--pastel-amber` | `#FEE1A7` | Content Creator disc |
| `--pastel-pink` | `#FFE0EF` | Frontend Developer disc |
| `--pastel-blue` | `#BDE7FF` | Backend Architect, AI Engineer, Short-Video Coach discs |
| `--pastel-mint` | `#EAFBF3` | "Agent generated" tag |
| `--stage-black` | `#191919` | Video letterbox stage behind a 9:16 artifact |

### 2.6 Colour usage ratio (observed)

```
White / near-white surfaces ....... 88%
Soft grey chips & dividers ........  7%
Brand green (fill) ................  4%
Identity accents (pink/cyan/… ) ...  1%
```

The palette is deliberately **monochrome + one accent**. Do not add a second brand hue.

---

## 3. Typography

### 3.1 Families (three, used with intent)

| Role | Family | Where |
|---|---|---|
| **UI sans** | Inter / SF Pro / similar geometric-humanist sans | Titles, rows, buttons, nav, chips |
| **Editorial serif** | Transitional serif (Source Serif / Georgia-class) | Only inside the *brief document* headline |
| **Mono** | JetBrains Mono / SF Mono class | Document UI: "Co-editable brief", `Edit`, `Comment`, `Export .md`, `Print / PDF`, `Reset` |

> **Signature move:** the feed post is styled as a *document inside the app* — serif
> headline, mono controls, warm paper background. That contrast (app chrome vs. document)
> is what makes the Feed screen feel like a publishing surface rather than a card list.

### 3.2 Scale (measured against the 825 px-wide captures)

| Token | Size | Weight | Line-height | Tracking | Used for |
|---|---|---|---|---|---|
| `--fs-display` | 34–36 px | 700 | 1.12 | −0.02em | Document headline (serif) |
| `--fs-h1` | 22 px | 700 | 1.25 | −0.01em | Screen titles ("Teamly AI", "Home") |
| `--fs-h2` | 19–20 px | 700 | 1.3 | −0.01em | Row titles ("Frontend Developer") |
| `--fs-h3` | 16–17 px | 600 | 1.35 | 0 | List titles ("Little T", "Overview") |
| `--fs-body` | 15–16 px | 400 | 1.5 | 0 | Descriptions, sub-headlines |
| `--fs-sm` | 13 px | 400/500 | 1.45 | 0 | Meta ("Created Oct 20, 11:08 PM"), tags |
| `--fs-eyebrow` | 11–12 px | 600 | 1.4 | **+0.12em, UPPERCASE** | "WEEKLY INDUSTRY BRIEF · TECHNOLOGY & SOFTWARE", "GETTING STARTED", "CHATS · 15" |
| `--fs-nav` | 11 px | 500/600 | 1.2 | 0 | Bottom-nav labels |
| `--fs-btn` | 14–15 px | 600 | 1 | 0 | Button labels ("Chat") |

**Rules:** titles are `--ink-900`; descriptions are `--ink-500`; meta is `--ink-300`.
Never bold a description — hierarchy comes from colour and size, not weight.

---

## 4. Spacing, radius, elevation

### 4.1 Spacing scale — 4 pt base

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | 4 px | Icon ↔ label gap |
| `--space-2` | 8 px | Chip inner gap, tight stacks |
| `--space-3` | 12 px | Inside rows |
| `--space-4` | **16 px** | **Standard screen gutter** (left/right) |
| `--space-5` | 20 px | Card inner padding |
| `--space-6` | 24 px | Between list groups |
| `--space-8` | 32 px | Section separation |

Observed: screen gutter is a consistent **16 px** on every screen; card padding is
**20 px**; vertical gap between cards is **12–16 px**.

### 4.2 Radius language — "soft pill"

| Token | Value | Applied to |
|---|---|---|
| `--radius-pill` | 999 px | Chips, tabs, "Chat" buttons, search field, avatar badges |
| `--radius-lg` | 24 px | Cards / list rows (Agents cards, feed card) |
| `--radius-md` | 16–20 px | Inner blocks, document panel, media frame |
| `--radius-sm` | 10–12 px | Small tags, badges ("1/2"), icon buttons |
| `--radius-xs` | 8 px | Video letterbox inner corners |

### 4.3 Elevation — shadow is barely there

| Token | Value | Use |
|---|---|---|
| `--elev-0` | none | Flat rows on `--bg-app-alt` |
| `--elev-1` | `0 1px 2px rgba(17,23,39,.04)` | Search field |
| `--elev-2` | `0 4px 16px rgba(17,23,39,.06)` | Cards (Agents rows, feed post) |
| `--elev-3` | `0 8px 28px rgba(17,23,39,.10)` | Bottom sheet / floating button |
| `--elev-green` | `0 6px 16px rgba(0,201,81,.28)` | Primary green CTA (subtle green glow) |

> White cards on `#FAFBFD` are separated mostly by **radius + whitespace**, not shadow.
> Keep shadows under 6% opacity — heavier shadows instantly break the look.

---

## 5. Iconography & illustration

| Element | Spec |
|---|---|
| UI icons | 20–24 px, **1.75 px stroke**, rounded caps, outline style (search, bell, heart, bookmark, comment, share) |
| Bottom-nav icons | 24 px outline; **active state = filled/closed outline + green tint + green label** |
| Agent avatars | 96 px **disc** with pastel fill + flat cartoon mascot, rounded 50%, thin white ring |
| Mascot style | Flat vector, black outlines, 2-tone, friendly robots (boxy head, antenna, screen-face) |
| Badge | Small green circle avatar-corner mark (friends-added ✔, YouTube badge) |
| Artifact stage | 9:16 media centred on `--stage-black` letterbox with pill arrow buttons |

---

## 6. Motion & interaction states

| State | Behaviour |
|---|---|
| Chip select | Background fades `--surface-chip` → `--green-500`, label `--ink-700` → white, 150 ms ease-out |
| Tab underline | 3 px `--green-500` bar slides under the active tab |
| Card press | Scale 0.985 + `--surface-tint` overlay, 120 ms |
| Button press | `--green-500` → `--green-600`, shadow collapses to `--elev-1` |
| Nav switch | Icon/label cross-fade to green, 180 ms |
| Page transition | Vertical push / cross-dissolve, 220 ms ease |
| Skeleton | Shimmer on `--surface-chip`, radius matches the real element |
| Empty state | Mascot illustration + `--ink-500` copy + one green CTA |

**Golden rule of feedback:** anything tappable is either a **pill** or a **full-width green
pill button**. No square tappables, no outlined buttons except the paused "Print / PDF"
secondary in the document toolbar.

---

## 7. Core component specs

### 7.1 Bottom navigation (global, on all 5 screens)

Present on **every** screenshot at the bottom, 5 destinations, fixed.

| # | Label | Icon | Notes |
|---|---|---|---|
| 1 | **Chat** | speech bubble | Default landing after login |
| 2 | **Agents** | robot head | Agent marketplace |
| 3 | **Discover** | compass | Green when active |
| 4 | **Memory** | brain + green **badge "1"** | Has unread/update count |
| 5 | **Artifacts** | stacked layers | Agent-generated deliverables |

Spec: height ≈ 72 px + safe area, `--surface` background, hairline `--divider` on top,
icon 24 px, label `--fs-nav`, inactive `--ink-300`, active `--green-700` (icon + label).

### 7.2 Segmented tabs (top of screen)

Two variants, both centred:

* **Text tabs** — "Following | Feeds" (Chat), "Agents | Agent Teams" (Agents), "Recent | Recently saved | Memory" (Artifacts). Active = `--ink-900` + 3 px green underline; inactive = `--ink-300`, no underline.
* **Pill segmented control** — "Agents | Automations" sits in a `--surface-chip` pill track, active half is a white pill with `--elev-1`.

### 7.3 Search field

Full-width, `--surface`, `--radius-pill`, height 52 px, `--elev-1`, leading 20 px search icon
in `--ink-300`, placeholder `--ink-300`. Examples: "Search posts, creators…",
"Search agents…", "Search topics…", "Search".

### 7.4 Pills & chips

* **Filter chip (neutral):** `--surface-chip` bg, `--ink-700` label, height 40 px, `--radius-pill`, 16 px h-padding.
* **Filter chip (selected):** `--green-500` bg, white label, height 44 px (slightly taller = dominant).
* **Special chip:** the selected "All ⟳" in the *Feeds* row carries a small refresh glyph — a "reset filters" affordance inside the active chip.
* **Status tag:** `--green-050` bg + `--green-700` text + sparkle icon ("✧ Agent generated").
* **Count badge:** `--green-500` circle, white 11 px numeral, 18 px Ø (nav Memory badge).
* **Meta counter:** e.g. `1/2` — `--ink-900` @ 80% on white pill, 12 px.

### 7.5 Cards

**A. Agent row card** (Agents screen) — the most repeated component.
```
┌────────────────────────────────────────────────────┐
│  (96px pastel avatar)   Title  (--fs-h2, ink-900)   │
│                         Description (--fs-body,    │
│                         ink-500, 2-line clamp)      │
│                                        [ Chat ]     │
└────────────────────────────────────────────────────┘
```
* `--surface`, `--radius-lg`, padding 20 px, `--elev-2`, gap 12 px between rows.
* Avatar disc left, text block flexible, **green pill "Chat" button 72 × 44 px right**, vertically centred.

**B. Feed post card** — a document preview with a footer bar.
* Outer card: `--surface`, `--radius-lg`, `--elev-2`, `--ink-900` title, then a **media/document viewport**, then a stats row.
* Stats row: heart `12` · bookmark `0` · comment `1` · share (paper-plane), then a **green circular sparkle FAB** at the right edge ("remix / generate from this post").
* Under the stats: bold 14 px title + 2-line `--ink-500` description (truncated with "…").

**C. Document panel** (inside feed card) — **warm paper `#F1F0EB`**, `--radius-md`, contains:
1. `● Co-editable brief` (mono, `--ink-900`) — green dot = "live/synced" status;
2. `All changes save locally in this browser` (mono, `--ink-500`);
3. Toolbar of white mono pills: **Edit · Comment · Export .md · Print / PDF · Reset** (wrap to 2 rows);
4. Then the article itself on the same paper: teal uppercase eyebrow (`#355F55`), **serif headline**, `--ink-700` sub-headline.

**D. Memory topic row** — 56 px icon tile (`--radius-md`, solid accent colour, white glyph)
· title `--fs-h3` · subtitle `--fs-sm` `--ink-500`. Grouped under a collapsible
uppercase label with a count ("⌄ GETTING STARTED 3").

**E. Artifact card** — media stage on black + metadata row + actions.
* Header row: hamburger · **Home** · grid/list view toggle (white pill, active = green icon) · list icon · bell with hairline divider.
* Tabs: Recent (green underline) | Recently saved | Memory · right-side sort icon.
* Body: single card — 9:16 media on `--stage-black` with **left/right pill nav arrows** and a `1/2` counter, bookmark button top-right, then `✧ Agent generated` tag + `VIDEO` label, `--fs-h2` title, `--fs-sm` timestamp, and an action row of **circled outline icon buttons** (comment, send, overflow).

### 7.6 Buttons

| Variant | Spec | Example |
|---|---|---|
| Primary pill | `--green-500` bg, white `--fs-btn` 600, height 44–48 px, radius pill, `--elev-green` | "Chat", "+ Create My Own Agent" |
| Header FAB | `--green-500` circle, 48 px Ø, white `+`, top-right | Chat & Feed screens |
| Secondary pill | white bg, `--ink-900` mono label, hairline border, 36 px | document toolbar |
| Icon button | 40 px Ø, `--surface`, 1 px `--divider`, `--ink-500` glyph | artifact actions |
| Link | `--green-link` 600, no underline | "+ New" |

### 7.7 Lists & grouping

Collapsible group headers are a system pattern: `⌄ LABEL · COUNT`
(e.g. `Pinned · 1`, `Chats · 15`, `GETTING STARTED 3`). Label is `--fs-eyebrow`
uppercase `--ink-300`; rows sit on white with 12 px gaps; the *first* row of a group is the
most recent and often gets a **green status dot** or a badge.

---

## 8. Layout grid & structure

```
┌─────────────────────────────────────────┐
│ ① Header / tabs      (sticky, 44–56px)  │  title or tab row + optional action
├─────────────────────────────────────────┤
│ ② Search + filters   (sticky, 52+56)    │  search field, then chip rail
├─────────────────────────────────────────┤
│ ③ Scroll body        (flex: 1)          │  cards, rows, groups
│    gutter 16px · card padding 20px      │
├─────────────────────────────────────────┤
│ ④ Bottom navigation  (72px + safe area) │  always visible
└─────────────────────────────────────────┘
```

* One column, single scroll region, 16 px gutters, 20 px card padding.
* Header + search + chip rail stay **sticky**; only region ③ scrolls.
* Horizontal **chip rails scroll edge-to-edge** and clip the last chip at the screen edge
  (a deliberate "there is more" cue — visible as a cut-off "Image" / "Data Analysis" chip).
* Floating header FAB sits in region ①, top-right, above the search field.
* Touch targets: minimum 44 × 44 px. Row min-height 72 px for agent cards, 56 px for list rows.

---

## 9. Accessibility & dark mode

**Contrast checks**

| Pair | Ratio | Verdict |
|---|---|---|
| `#111727` on `#FFFFFF` | ≈ 16.6:1 | ✅ AAA |
| `#6B7280` on `#FFFFFF` | ≈ 4.8:1 | ✅ AA (body) |
| `#B9BABE` on `#FFFFFF` | ≈ 2.0:1 | ⚠️ placeholders only — never load-bearing text |
| White on `#00C951` | ≈ 2.3:1 | ⚠️ **fails for small text** → use 15 px/600+ or a darker green `#00A344` for tiny labels |
| `#18964D` on `#FFFFFF` | ≈ 3.9:1 | ✅ AA for large/600 weight green text |

**Rules**

1. Never render white text smaller than 14 px 600 weight on `#00C951`. For small green
   labels use `--green-700` on white instead of white on green.
2. Never use `#00C951` as a text colour on a white background — it is a fill token.
3. Do not encode state with colour alone: pair the green dot with a word ("NEW", "Agent
   generated") and pair the active tab with an underline as well as a colour change.
4. Respect `prefers-reduced-motion`: keep colour/opacity transitions (150 ms) but drop
   scale and slide animations.
5. Hit areas ≥ 44 px even when the glyph is 20 px (pad the icon button).

**Proposed dark-mode tokens** (not in the shots — extrapolated to keep the same relationships)

| Token | Light | Dark |
|---|---|---|
| `--bg-app` | `#FAFBFD` | `#0E1116` |
| `--bg-app-alt` | `#F1F4F9` | `#151A21` |
| `--surface` | `#FFFFFF` | `#191E26` |
| `--surface-chip` | `#F5F6FA` | `#232A34` |
| `--surface-paper` | `#F1F0EB` | `#22242A` |
| `--ink-900` | `#111727` | `#F2F4F7` |
| `--ink-500` | `#6B7280` | `#9AA3AF` |
| `--ink-300` | `#B9BABE` | `#5F6875` |
| `--green-500` | `#00C951` | `#00D45B` (keep — it pops on dark) |
| `--green-700` (text) | `#18964D` | `#3ED37A` |
| `--divider` | `#EEEEEE` | `#252B34` |

---

## 10. Drop-in CSS tokens

```css
:root{
  /* brand */
  --green-500:#00C951; --green-600:#00B548; --green-700:#18964D;
  --green-050:#EAFBF1; --green-link:#06A046;

  /* surfaces */
  --bg-app:#FAFBFD; --bg-app-alt:#F1F4F9; --surface:#FFFFFF;
  --surface-chip:#F5F6FA; --surface-paper:#F1F0EB; --surface-tint:#F3F4F6;
  --divider:#EEEEEE;

  /* ink */
  --ink-900:#111727; --ink-800:#191919; --ink-700:#3A4149;
  --ink-500:#6B7280; --ink-300:#B9BABE; --ink-teal:#355F55;

  /* identity accents */
  --accent-pink:#EB4899; --accent-cyan:#07B6D5;
  --accent-amber:#FACC15; --accent-violet:#A755F7;

  /* pastels + stage */
  --pastel-amber:#FEE1A7; --pastel-pink:#FFE0EF; --pastel-blue:#BDE7FF;
  --pastel-mint:#EAFBF3; --stage-black:#191919;

  /* type */
  --font-sans:'Inter',-apple-system,'Segoe UI',sans-serif;
  --font-serif:'Source Serif 4',Georgia,serif;
  --font-mono:'JetBrains Mono','SF Mono',ui-monospace,monospace;
  --fs-display:35px; --fs-h1:22px; --fs-h2:19px; --fs-h3:16px;
  --fs-body:15px; --fs-sm:13px; --fs-eyebrow:11px; --fs-nav:11px; --fs-btn:15px;

  /* space + radius */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px;
  --radius-pill:999px; --radius-lg:24px; --radius-md:18px;
  --radius-sm:12px; --radius-xs:8px;

  /* elevation */
  --elev-1:0 1px 2px rgba(17,23,39,.04);
  --elev-2:0 4px 16px rgba(17,23,39,.06);
  --elev-3:0 8px 28px rgba(17,23,39,.10);
  --elev-green:0 6px 16px rgba(0,201,81,.28);
}
```

---

## 11. Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| Keep ~88% of the screen white/near-white | Fill backgrounds with colour blocks |
| Use green only for action + active state | Use green for decoration or borders |
| Fill with `--green-500`, write with `--green-700` | Put white small text on `--green-500` |
| 24 px radius cards, pill chips | Square corners / 4 px radii |
| Grey `--ink-500` descriptions, light `--ink-300` meta | Bold descriptions for hierarchy |
| Serif headline + mono controls *inside documents* | Use serif anywhere in the app chrome |
| Pastel discs behind mascot avatars | Recolour the mascots themselves |
| Shadows ≤ 6% opacity | Heavy drop shadows / dark borders |
| Scroll chip rails past the edge | Wrap chips onto multiple lines |

---

## 12. Theme summary in one paragraph

A **white, airy, editorial workspace** lit by one electric green. The app chrome is
purely functional: white cards on a near-white canvas, soft 24 px corners, hairline
dividers, grey secondary text, and a **single `#00C951` signal green** used exclusively
for the primary action, the selected state and the active tab. Playfulness arrives through
**pastel discs of flat cartoon robots** (amber, pink, blue) and a four-colour identity
palette (pink · cyan · amber · violet) used only for the Memory topic tiles. The signature
moment is the **document-inside-the-app** treatment on the Feed screen: a warm-paper panel
`#F1F0EB` with mono toolbar pills, a teal uppercase kicker and a serif headline — bridging
"AI chat app" and "real publishing tool". If forced to one line:

> *Flat, friendly, pill-heavy, mostly white — with a green that means "go".*