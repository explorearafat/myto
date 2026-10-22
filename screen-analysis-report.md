# Teamly AI — Screenshot Analysis Report

**What this is:** a read of the five attached screenshots — what each screen is, what has
actually been built in it, which section each element belongs to, and what job it does.
Companion file: **`design-and-theme.md`** (the extracted design system).

**The five shots — one per tab, no gaps:**

| # | File | Screen | Bottom-nav tab |
|---|---|---|---|
| 1 | `..._22.12.39.jpeg` (70.7 KB) | **Chat** — chat / contacts home | **Chat** |
| 2 | `..._22.12.39__1_.jpeg` (86.8 KB) | **Agents** — agent marketplace list | **Agents** |
| 3 | `..._22.12.40.jpeg` (94.5 KB) | **Discover / Feeds** — document feed post | **Discover** |
| 4 | `..._22.12.40__1_.jpeg` (68.2 KB) | **Memory** — wiki / knowledge base | **Memory** |
| 5 | `..._22.12.40__2_.jpeg` (48.9 KB) | **Artifacts** — Home, generated media | **Artifacts** |

All five are **distinct screens**, and they map **one-to-one onto the five tabs of the
bottom navigation bar**: Chat · Agents · Discover · Memory · Artifacts. Nothing is missing —
the whole navigable app is covered by your screenshots.

---

## 0. What the product is

**Teamly AI** is a **mobile-first personal AI workspace**. It is not a single chatbot: it is
an app where you (a) chat with AI agents, (b) shop for / assemble teams of specialised
agents, (c) read and co-edit a feed of generated briefs, (d) build a private wiki that
fills itself from your chats and documents, and (e) collect the deliverables those agents
produce. It is aimed at knowledge workers — the persona explicitly shown in the Memory
screen is *"a Software Engineer in Technology & Software"*.

**Core loop inferred from the screens:**

```
Chat with an agent  →  it produces an Artifact (brief / video / doc)
        ↑                          ↓
   Memory / Wiki  ←────  Discover feed  ←── Agent Teams collaborate
```

The status bar text is in **Bengali** (`১`, `২ ৩০` = 1, 2:30) while the whole UI is English
— so this is a **Bangladesh-market user** (or a Bengali-locale device) using an
English-language product. Worth noting for localisation and test data.

---

## 1. Screen A — Chat / Home  (`..._22.12.39.jpeg`)

**Navigational role:** the app's **default landing tab** (first icon in the bottom nav).

### Layout, top to bottom

| Zone | What's there | What it does / which section |
|---|---|---|
| Header | Avatar (profile photo) · **Teamly AI** title centred · **green `+` FAB** | Identity + "start something new" — `+` = new chat/agent. The avatar is the only custom image in the chrome → this is the *messages* app-header pattern, not an *app* header |
| Search | Full-width pill, "Search" | Global search **within chats only** (note: shorter placeholder than other screens) |
| Row 0 | **Little T** — "Your YouTube Short is ready! 🐦⚡" — **Tue** | **Agent output notification row**, not a human chat. Badge: robot avatar + YouTube mark |
| Group 1 | `📌 Pinned · 1` | Collapsible group. Contains **Teamly Agent ✔** — "You are now friends" |
| Group 2 | `💬 Chats · 15` | Collapsible group of 15 conversations |

**Chats inside group 2 (in order):**

1. **AI Feature Build Room** — subtitle: "AI Engineer, Prompt Engineer, Data Engineer, Frontend..."
2. **Code Review Guild** — "Code Reviewer, Senior Developer, Git Workflow Master,..."
3. **Software Architect** — "You are now friends"
4. **Bug Analysis Agent** — "You are now friends"
5. **Principal Architect** — "You are now friends"
6. (partially visible row at the bottom edge)

### What this tells us — the key insight of this screen

**Three kinds of entity live in the same list:**

* **Team chats** — "AI Feature Build Room", "Code Review Guild" carry **stacked multi-avatar
  avatars** (2 overlapping discs: your photo + a robot) and a subtitle that is a *comma-separated
  list of agent roles*. → a **group chat with a team of agents**.
* **Single agents** — Software Architect, Bug Analysis Agent, Principal Architect have **one
  robot disc** and the subtitle **"You are now friends"**. → a **1:1 agent friendship/model**,
  deliberately worded as social, not as a tool.
* **System/notification** — Little T is pinned to the top above everything, with a **time
  stamp (Tue)** and a *delivery* message ("is ready!"). → **agent completion notification**,
  not a conversation.

**Therefore the Chat section = "inbox", and its real job is to be the *hub*: agent results,
team rooms and 1:1 agent chats all surface here.** The `Chats · 15` count also proves
sessions are **persistent and grouped**, not ephemeral.

**Avatar + badge system (used app-wide):**
* Group = stacked avatars; 1:1 agent = single robot disc.
* The green dot on the avatar corner = **relationship state** ("friends", i.e. connected).
* Row type is readable from the avatar alone — good information design.

---

## 2. Screen B — Agents  (`..._22.12.39__1_.jpeg`)

**Navigational role:** the **marketplace / directory** — 2nd bottom-nav tab.

### Layout, top to bottom

| Zone | What's there | Job / section |
|---|---|---|
| Segmented pill | **Agents** \| Automations | Agents = talk to a role; Automations = unattended jobs. Active = white pill |
| Tabs | **Agents** \| Agent Teams | Two alternative taxonomies: individuals vs. pre-built crews |
| Search + CTA | "Search agents..." + **`+ Create My Own Agent`** (green pill) | Search **scoped to this directory**; CTA = **agent builder** (personalisation) |
| Source filter | **By Teamly AI** \| My Custom Agents | Splits **official catalogue** from **your own creations** — same row as the CTA on purpose: "browse ours / make yours" |
| Category rail | **All** · Content Creation · Customer Support · Data Analysis… | Horizontally scrolling categories, clip at edge = more exist |
| List | Agent cards | The catalogue |

### The catalogue rows (visible)

| Agent | Avatar disc | Description (truncated) | Category (inferred) |
|---|---|---|---|
| **Content Creator** | amber | "Expert content strategist and creator for multi-platform campaigns. Develops…" | Content Creation |
| **Frontend Developer** | pink | "Expert frontend developer specializing in modern web technologies,…" | Engineering |
| **Backend Architect** | blue | "Senior backend architect specializing in scalable system design, database…" | Engineering |
| **AI Engineer** | blue | "Expert AI/ML engineer specializing in machine learning model development,…" | Data / AI |
| **Short-Video Editing Coach** | blue | "Hands-on short-video editing coach" | Media / Content |

**Strong pattern to note:** every row is *identical in structure* — pastel disc, bold role
title, one-line professional description, green **Chat** pill at the right. The description is
always written as a **resume-style credential line** ("Expert … specializing in …"). This is
the single most reusable component in the app.

**What it reveals about the product:** the agents are presented as **hire-able colleagues**
(job titles, seniority words like *Senior* / *Principal* / *Expert* / *Lead*), not as features.
That is why the same list reappears in the Chat tab as "friends".

---

## 3. Screen C — Discover / Feeds  (`..._22.12.40.jpeg`)

**Navigational role:** the **content/publishing surface** — 3rd bottom-nav tab (green when
active, labelled *Discover*).

### Layout

| Zone | What's there | Job |
|---|---|---|
| Tabs | **Following** \| **Feeds** (active, green underline) | Following = creators you follow; Feeds = algorithmic/public stream |
| Search | "Search posts, creators..." | Search across **people and posts** — a *social* search, unlike the Agents tab |
| Filter rail | **All ⟳** (selected, with refresh glyph) · Trending · Webpage · Mini Game · Image | **Content-type filters** — and crucially: *Webpage / Mini Game / Image* are **artifact types**, so this feed is fed by agents producing things, not just text |
| Post | Author row · document panel · stats · description | One generated post |

### Anatomy of the feed post (the richest component in the whole app)

1. **Author row** — avatar disc with a verified/robot mark, bold **"Unknown author"**, then a
   **green `+` (follow/add)** button. → attribution is currently a placeholder ⇒ *the author
   identity system is not finished / anonymised in this build*.
2. **Document panel** (cream `#F1F0EB`), containing:
   * `● Co-editable brief` ← status dot = live document
   * `All changes save locally in this browser` ← **storage model stated in the UI**
   * Toolbar: **Edit · Comment · Export .md · Print / PDF · Reset** ← this is a **real
     document editor**, not a read-only card. Notice `.md` — the source of truth is
     **Markdown**.
   * The brief itself: eyebrow `WEEKLY INDUSTRY BRIEF · TECHNOLOGY & SOFTWARE` (teal, uppercase,
     letterspaced) → **serif headline** *"Software engineering: the week agentic coding became
     the default"* → grey sub-headline starting *"Seven days of evidence that code…"*
3. **Footer/overlay bar** (white, sits over the truncated document): bold title
   *"Weekly Industry Brief for Software Engineers in Technology & Softwares"* + engagement row:
   **♡ 12 · 🔖 0 · 💬 1 · ✈ share**, and a **green circular sparkle FAB**.
4. **Description** — *"This co-editable weekly industry brief provides a concise overview of key
   developments for software engineers in the technology and software…"*

### Three high-value conclusions about this screen

* **Discover is a feed of agent-made *documents*, and those documents are co-editable.** That
  is the most distinctive idea in the product: the timeline is a *newsletter you can edit*.
* The **Sparkle FAB** = "generate/remix from this post" — it turns consumption into production
  (an input to the agent loop).
* The **localStorage note is a warning sign in the design**: "saves locally in this browser"
  means no cloud sync for those edits. Either it is a prototype constraint or an intentional
  privacy/local-first feature — it should be made explicit to the user either way.

---

## 4. Screen D — Memory / Wiki  (`..._22.12.40__1_.jpeg`)

**Navigational role:** the **knowledge base** — 4th bottom-nav tab, and the tab that carries
the **green "1" badge** (unread/updated).

### Layout

| Zone | What's there | Job |
|---|---|---|
| Search | "Search topics..." | Search the private wiki only |
| Toolbar row | **All 3** · **Updates 1** · **Tags ⌄** · **`+ New`** (green link) | All = everything; **Updates** = unread deltas (matches the nav badge "1"); **Tags** = filter by tag; `+ New` = create a wiki page |
| Pinned tiles | **Overview** (pink 🎛) · **My Profile** (cyan 👤) · **Next Actions** (amber 📅) · **My Artifacts** (violet ▣) | **Four fixed, colourful "system" pages** — the only place colour tiles appear. Overview = map of all topics; My Profile = your work/life profile; Next Actions = upcoming; My Artifacts = all deliverables |
| Group | `⌄ GETTING STARTED 3` | Collapsible section (uppercase eyebrow label) |
| Rows | 3 documents with `NEW` dot | Freshly generated wiki pages |

### The three Getting-Started documents (and what they prove)

| Title | Subtitle | Meta |
|---|---|---|
| **Welcome to Teamly** | "What Teamly is — Personal AI, agents & teams, group chats, crea…" | `just now` · `#getting-started` `#onboarding` |
| **Teamly Wiki: Your Personal Knowledge Base** | "How your private wiki builds itself from chats, handles conflicts, …" | `just now` · `#wiki` `#onboarding` |
| **About Me** | "Your home base as a Software Engineer in Technology & Softwar…" | `1 hour ago` · `#software-engineering` `#technology` |

**This is the biggest reveal in all five screenshots.** Line 2 literally says the wiki
**"builds itself from chats"** and **"handles conflicts"**. So Memory is not a manual
notepad — it is an **auto-generated wiki with conflict resolution**, and "About Me" is an
**auto-inferred user profile** created from your chats. Combined with the Chat tab's agent
roles, the product thesis becomes clear: **the agents do the work, the wiki remembers it,
and the user never writes a summary.**

The `NEW` dot + the `1` badge + the `Updates 1` filter are all the same signal, repeated in
three places — that's a deliberate "something changed while you were away" system.

---

## 5. Screen E — Artifacts / Home  (`..._22.12.40__2_.jpeg`)

**Navigational role:** the **deliverables library** — 5th bottom-nav tab (green when active).

### Layout

| Zone | What's there | Job |
|---|---|---|
| Header | ☰ menu · **Home** · **view toggle** (grid \| list, grid active = green) · list icon · 🔔 bell with a hairline divider before it | Navigation + layout switch + notifications |
| Tabs | **Recent** (green underline) · Recently saved · Memory | Three ways to slice artifacts. Note *Memory* appears **again** here → the two systems are cross-linked |
| Sort | ⇅ icon, right side | Sort control for the list |
| Body | **One** artifact card | Empty-ish state: only one deliverable so far |

### The artifact card

* **Media stage** — the 9:16 animation sits centred on a **black letterbox**, with a **bookmark**
  button (top-right), **‹ › pill arrows** (left/right) and a **`1/2` counter** → it is a
  **carousel of a 2-asset artifact**.
* Content: the frame shows a **flat cartoon chick on a wire under a sun, blue sky, power poles**
  — i.e. the artifact really is a generated animation.
* Metadata: **`✧ Agent generated`** tag (mint chip) + **`VIDEO`** label, title
  **"Animated Science Short"**, timestamp **"Created Oct 20, 11:08 PM"**.
* Actions row: **comment · send/share · ⋯ overflow**, each a circled outline icon button.

**What it proves:** artifacts are **multi-asset, typed (VIDEO), agent-attributed, and shareable**,
and this tab is the *vault* where the Chat tab's "Your YouTube Short is ready!" notification
lands. The `1/2` counter is also an important detail: one artifact = **several media pieces**
(storyboard + final, or 2 videos) — so the data model is *artifact → media[]*, not 1:1.

---

## 6. Cross-screen comparison — which section does what

| Bottom-nav tab | Screen | Primary job | Search scope | List entity | Right-edge action |
|---|---|---|---|---|---|
| **Chat** | Chat/Home | Inbox & hub for all agent interaction | Chats | Chat / team / agent | open thread |
| **Agents** | Agents | Browse & hire agents, build your own | Agents | Agent card | **Chat** (green pill) |
| **Discover** | Feeds | Read + co-edit agent-made documents | Posts & creators | Post | **sparkle** (remix) |
| **Memory** | Wiki | Auto-built private knowledge base | Topics | Wiki doc | `+ New` |
| **Artifacts** | Home | Collect everything agents produced | (none — none visible) | Media artifact | ⋯ overflow |

### Repeated structural template (proves a real design system exists)

Every one of the five screens follows the **same four-zone skeleton**:

```
[ header / tabs ]  →  [ search + filter chips ]  →  [ scrolling list body ]  →  [ bottom nav ]
```

* **Search always sits directly under the header**, above the filters — no exceptions.
* **Filter chips are always a horizontally scrolling pill rail**, never a dropdown.
* **Lists are always white rounded cards/rows on a near-white canvas** with 12–16 px gaps.
* **Bottom nav is identical in all five shots** — 5 items, same order, same icons.

### Elements shared across sections (build once, reuse five times)

| Component | Seen on |
|---|---|
| Search pill | all 5 |
| Selected green chip | Agents, Discover |
| Neutral chip rail | Agents, Discover |
| White rounded list card | Agents, Chat, Memory |
| Pastel/coloured circular avatar | all 5 |
| Collapsible uppercase group header | Chat, Memory |
| Green pill CTA | Agents, Memory, Discover |
| Green status dot / badge | Chat, Memory, Artifacts |
| Bottom navigation | all 5 |

---

## 7. What is actually built vs. what is still a placeholder

| Evidence in the screenshots | Reading |
|---|---|
| **"Unknown author"** with a `+` follow button | Author/profile identity is **not populated** — prototype data |
| **Empty-ish Artifacts** (1 card, `1/2`) | The artifact pipeline is **youngly populated** |
| **"All changes save locally in this browser"** | Persistence is **localStorage**, no cloud doc sync yet |
| **Memory badge `1`** + **`Updates 1`** + one `NEW` | Exactly **one unread update** — matches, so the badge is live data |
| **`just now` / `1 hour ago`** timestamps | Content was generated **within the hour** → a live demo/onboarding session |
| **`Chats · 15`, `Pinned · 1`, `All 3`, `GETTING STARTED 3`** | Real counters attached to collapsible groups |
| **"You are now friends"** on 4 agents | Relationship/friending state is implemented per-agent |
| **`Getting Started` group = onboarding content** | Onboarding is delivered **as wiki pages**, not as a tour overlay — a strong, unusual choice |

**Status:** this looks like a **working alpha / late prototype**: navigation, listing,
filtering, document editing and artifact viewing are all present and wired, while author
identity, artifact volume and cloud persistence are still thin.

---

## 8. Product model inferred (the object graph)

```
User
 ├── Chats  (1:1 agent chats + team group chats)   ← Chat tab
 ├── Agents (official catalogue + my custom)       ← Agents tab
 │     └── Agent Teams (a named set of agents)
 ├── Wiki topics (Overview, My Profile, Next Actions, My Artifacts)
 │     └── Documents  ← auto-generated from chats, with #tags + NEW state   ← Memory tab
 ├── Artifacts
 │     └── Media[] (VIDEO / image / webpage / mini-game)                    ← Artifacts tab
 └── Feed posts  (a Document + author + likes/bookmarks/comments)           ← Discover tab
```

**Relationships that the UI implies:**

* A **Feed post** is a **Document** plus social metadata → the same object appears in Discover
  and (as "My Artifacts") in Memory. **One content object, several views.**
* **Chats produce Artifacts** (Little T's "Your YouTube Short is ready!") → Artifacts is the
  output queue of the Chat tab.
* **Chats feed the Wiki** ("builds itself from chats") → Memory is the *memory* layer of the
  same chats. Chat in, Artifact + Wiki out.
* **Agents are the workers;"friends" are the ones you've connected with** → the social metaphor
  is a UI device for managing *which* agents are in your workspace.

**One sentence:** *Teamly AI = a chat inbox in front, an agent roster in the middle, and a
self-writing wiki + artifact vault behind it.*

---

## 9. UX observations & risks found in the shots

| # | Observation | Why it matters / suggestion |
|---|---|---|
| 1 | Five tabs, and **Chat / Agents / Discover / Memory / Artifacts** each open with a *different* filter pattern (tabs, segmented pills, chip rail, count chips, view toggles) | Excessive variety for one app; standardise on at most 2 patterns for consistency |
| 2 | **"Memory" appears both as a bottom-nav tab and as a tab inside Artifacts** | Naming collision — a user will not know which "Memory" they are in. Rename one (e.g. *Wiki* vs *Artifacts ✓ Saved*) |
| 3 | **"Chats" in the bottom nav but the screen is titled "Home" in Artifacts** | Inconsistent mental model of the same root. Pick one concept |
| 4 | Green text `#00C951` on white in the *Feeds* active tab / underline is fine, but small white-on-green labels risk contrast failure | See `design-and-theme.md` §9 — use `#18964D` for green text, 15 px/600 minimum on green fill |
| 5 | **Cut-off chip at the right edge** ("Image", "Data Analysis") | Intentional overflow cue, but with no gradient fade it can read as a bug — add a soft fade mask |
| 6 | **"Unknown author"** is user-visible | Placeholder leaking into the UI — fill in or hide |
| 7 | **"All changes save locally in this browser"** | The most important privacy/durability message in the app, styled as small mono grey. If edits can be lost, this needs to be a real, visible caveat |
| 8 | Every agent card's **Chat** button is identical green | Good consistency, but no way to tell "already chatting" vs "new" — a state dot on the button would help (the Chat tab already uses "friends" dots for this) |
| 9 | **Little T is pinned above "Pinned"** | Two competing pin mechanisms — the notification row should either sit inside Pinned or be labelled as "Updates" |
| 10 | **The document toolbar wraps to 2 rows** (*Edit, Comment, Export .md* then *Print / PDF, Reset*) | A 5-action toolbar inside a feed card is heavy for mobile; move Print/Export/Reset into an overflow menu |
| 11 | **Artifact REALLY shows only one item** | No empty state copy is visible — if zero artifacts existed the tab would need illustration + CTA. Define that state |
| 12 | Bengali numerals in the status bar, English UI | Confirm locale strategy: numbers in Bengali but interface English is a mixed-language experience |

---

## 10. What I understand, in six lines

1. **Teamly AI is a mobile AI-workspace app, not a chatbot** — five tabs, five jobs:
   Chat (inbox) · Agents (roster) · Discover (feed) · Memory (wiki) · Artifacts (vault).
2. The **unit of work is the Agent** — presented as hireable colleagues with job titles,
   pastel avatars and "become friends" relationship states, plus **Agent Teams** for group chats.
3. The **unit of output is the Artifact** — multiple typed media (VIDEO, Webpage, Image, Mini Game)
   held in a carousel, attributed `✧ Agent generated`.
4. The **Memory tab is the product's real moat** — a private wiki that *"builds itself from
   chats"* and *"handles conflicts"*, including an auto-derived "About Me" profile.
5. **Discover turns the output into a social, co-editable feed** — posts are live Markdown
   documents with Edit/Comment/Export/Print, plus likes, bookmarks, comments and a sparkle
   "make my own from this" action.
6. **The visual system is already consistent** — white canvas, `#00C951` signal green for
   action/active only, pill-shaped controls, 24 px card radii, pastel mascot discs, and a
   warm-paper serif document treatment as the signature flourish.

---

*Report generated from the five attached screenshots. Colour values referenced in this file
were sampled pixel-by-pixel from the images — see `design-and-theme.md` for the full token set.*