# dsh-plugin-computer-use

Codex-style computer use for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The plugin registers one model-facing tool, `computer`, whose action vocabulary and
batch contract mirror OpenAI's [`computer` tool](https://developers.openai.com/api/docs/guides/tools-computer-use).
The model sends an ordered batch of actions, the plugin runs them against the real
desktop, and returns a fresh screenshot plus an exact record of what ran — so a model
already trained on that interface needs no new vocabulary.

On macOS the input events are posted by a small Objective-C helper compiled from source
on first use, with an AppleScript fallback for machines without a compiler.

```
┌─────────────┐   actions[]    ┌──────────────────────────────────────┐
│   model     │ ─────────────► │ computer tool                        │
│             │                │  normalize → map coords → post input │
│             │ ◄───────────── │  capture → commit → render           │
└─────────────┘  screenshot +  └──────────────────────────────────────┘
                 executed[]        │              │
                                   │ CGEvent      │ screencapture
                                   ▼              ▼
                              the desktop    the screen
```

## What it does

| Action | Fields | Effect |
| --- | --- | --- |
| `screenshot` | — | Observe. The result screenshot is taken after the batch regardless. |
| `click` | `x`, `y`, `button?`, `keys?` | Move and click. `button` is `left` (default), `right` or `middle`. |
| `double_click` | `x`, `y`, `keys?` | Two clicks with the platform's double-click semantics. |
| `move` | `x`, `y`, `keys?` | Move the pointer without clicking. |
| `drag` | `path`, `button?`, `keys?` | Press at the first point, move through the path, release at the last. |
| `scroll` | `x`, `y`, `scroll_x`, `scroll_y`, `keys?` | Scroll at a point. Positive `scroll_y` scrolls down. |
| `keypress` | `keys` | A chord, e.g. `["CTRL","C"]` or `["ENTER"]`. |
| `type` | `text` | Type literal text, including spaces and newlines. |
| `wait` | — | Pause (duration from configuration, 2 s by default). |

The action set, the field names, and the sign convention for `scroll` are deliberately
the same as the reference implementation, so batches are portable between harnesses.

## Install

```sh
# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-plugin-computer-use

# or once published / from git
dsh plugin --profile <profile> add dsh-plugin-computer-use
```

Then add a row to the agent preset that should get the tool. Copy a shipped preset and
edit the copy — never edit a preset that ships with the deployment:

```yaml
- id: tool-computer-use
  name: dsh-plugin-computer-use
  config:
    display: 0
```

See [`examples/agent.cordis.yml`](examples/agent.cordis.yml) for a full row with every
option, and `dsh-agent-presets` for how presets are discovered and mounted.

## Permissions

macOS gates both halves of this tool, and the tool refuses to run without them rather
than failing mysteriously. Grant both to the application that hosts the agent:

| Permission | Needed for | Where |
| --- | --- | --- |
| **Screen Recording** | every screenshot | System Settings → Privacy & Security → Screen Recording |
| **Accessibility** | every click, key and scroll | System Settings → Privacy & Security → Accessibility |

Two details worth knowing:

- **Screenshots work without Accessibility.** The gates are independent, so a
  `screenshot`-only batch still succeeds on a machine that has not granted it. That is
  the safe subset, and it is useful on its own.
- **Without Accessibility, input events are discarded silently.** `CGEventPost` reports
  success and macOS drops the event. That is why the tool preflights the permission
  instead of trusting the call: an agent that skipped the check would click into the
  void, see an unchanged screen, and loop forever.

Run the doctor to see exactly where you stand:

```sh
npx dsh-computer-use-doctor --test-input
```

```
  platform              darwin (arm64)
  backend               native

displays
  [main] display 0  1470x956 pt  2940x1912 px  2x  origin (0, 0)

permissions
  [FAIL] Accessibility — post clicks and keystrokes
         add the host application under System Settings > Privacy & Security > Accessibility
  [OK  ] Screen Recording — capture the screen

capture
  [OK  ] main display: 2940x1912 px PNG

input delivery
  [FAIL] posted events are being discarded
```

`--test-input` moves the cursor by 40 points, confirms it followed, and puts it back —
a permission flag is an assertion, a moved cursor is evidence.

## Model requirements

Every result carries a screenshot, so the calling route must declare **image input**.
The tool checks this before doing any work and refuses rather than spending a capture on
a model that cannot read it:

```
Error: the computer tool returns screenshots as images, but model "…" does not declare
image input. Switch to an image-capable model, or set `requireImageCapableModel: false`
to run it blind.
```

On a provider that declares its models explicitly, that declaration is not automatic. A
provider configured through `llm-pi-ai` defaults **every** model to `input: ["text"]`, so a
vision model that never states its modalities is treated as text-only — and this tool, and
`read_image`, will both refuse. Name the modalities on the model entry:

```yaml
llm-pi-ai:
  providers:
    <provider>:
      models:
        - id: some-vision-model
          name: some-vision-model
          input: [text, image]    # without this the model reads as text-only
```

Setting `requireImageCapableModel: false` is the escape hatch, but it does not make the
model see: the screenshot is still captured and returned, and the model simply cannot use
it. Prefer declaring the modalities.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the tool at all. |
| `backend` | `"auto"` | `auto`, `native` or `applescript`. `auto` prefers native and degrades. |
| `display` | `0` | Which display to drive (0-based, main display first). |
| `maxActionsPerCall` | `25` | Upper bound on one batch. |
| `waitMs` | `2000` | Duration of a `wait` action. |
| `settleMs` | `250` | Pause after input, before the result screenshot. |
| `allowedActions` | `null` | Allow-list of action types; `null` permits all. |
| `invertScroll` | `false` | Flip the scroll sign convention. |
| `helperCacheDir` | `null` | Where to cache the compiled helper. |
| `requireImageCapableModel` | `true` | Refuse to run when the calling route cannot see images. |

An unknown field is rejected rather than ignored: a typo in a composition row must not
leave a deployment believing it disabled something it did not.

### Locking it down

Computer use is powerful, and a screenshot is attacker-controlled input. Two
configuration knobs do real work:

```yaml
- id: tool-computer-use
  name: dsh-plugin-computer-use
  config:
    # Read-only: the model can look at the screen but never touch it.
    allowedActions: [screenshot, wait]
```

```yaml
- id: tool-computer-use
  name: dsh-plugin-computer-use
  config:
    # No clicking, no typing: move and scroll only.
    allowedActions: [screenshot, move, scroll, wait]
```

The plugin also registers a system-prompt section instructing the model to treat
on-screen content as untrusted, to verify after acting, and to confirm before anything
hard to reverse. Prompt guidance is not an enforcement boundary — the allow-list is.

## How it works

### Coordinate spaces

Three spaces are in play, and conflating them is the classic computer-use bug:

| Space | What it is |
| --- | --- |
| **image space** | pixels of the PNG the model actually received — the attachment service may downscale a large capture |
| **pixel space** | pixels of the capture on disk, i.e. the display's real backing resolution |
| **point space** | the global, top-left-origin space `CGEvent` posts into; a Retina display has twice as many pixels as points |

The model measures in image space; the helper posts in point space. The plugin keeps the
geometry of the last screenshot it returned, per agent, and maps every incoming
coordinate out of it — so the model never scales anything itself, and the result text
always states the ratio it can check against:

```
screenshot 2940x1912 px · display 1470x956 pt · backing scale 2x · 1 screenshot px = 0.5x0.5 display pt
```

The capture is treated as authoritative about backing pixels, because
`CGDisplayPixelsWide` reports the *point* size on a display running a scaled Retina mode.

### Why the helper is compiled, and why screenshots skip it

The helper is compiled from source on first use and cached by source digest. Compiling
rather than shipping a binary keeps the package portable across architectures and free of
an unsigned-blob download; it costs about 0.6 s once. If `~/Library/Caches` is not
writable it falls back to the system temporary directory rather than losing the native
backend.

That fallback has a cost worth knowing, because the helper's **path is a permission
identity**: macOS binds an Accessibility grant to the binary, not to the tool. The system
temporary directory is reclaimed without warning, so a grant made against a helper there
stops working later, silently. The doctor prints the directory and the exact binary, and
says so when it is the volatile one:

```
  helper cache          /var/folders/…/T/dsh-plugin-computer-use  (volatile)
         the system reclaims this directory, so an Accessibility grant made against
         /var/folders/…/T/dsh-plugin-computer-use/computer-helper-27836c7760923b3c
         stops working once it does. Set `helperCacheDir` to a stable path, for
         example ~/Library/Caches/dsh-plugin-computer-use, and start a new session.
```

Set `helperCacheDir` to a stable path when the host cannot write the user cache — a
sandbox that only permits writes inside the workspace, for example.

Screenshots go through the system `screencapture` binary, not the helper, because
`CGDisplayCreateImage` is **obsoleted from macOS 15 onward** (ScreenCaptureKit replaced
it). Capture is the part of this tool most likely to break on a future release, so it
leans on a utility Apple maintains. The exact pixel dimensions are read from the PNG's
own IHDR chunk — no image library, no guesswork.

### Backends

| Backend | Input | Displays | Needs |
| --- | --- | --- | --- |
| `native` | full action set, precise | all, with correct origins | Xcode Command Line Tools (`clang`) |
| `applescript` | `click`, `keypress`, `type`, `wait` only | main display only | nothing beyond macOS |

`auto` prefers native and degrades to AppleScript when the toolchain is missing, because
a working reduced backend beats a hard failure. An explicit `backend: native` is honoured
exactly — a compile failure is reported, not quietly downgraded. When `auto` does
degrade, the reason is carried on the resolved backend so diagnostics can explain it.

## Development

```sh
npm install     # fetches @deepseek-ai/dsh-tools, needed by the schema suites
npm test        # 108 tests: pure logic + a real compile of the native helper
npm run doctor  # check permissions on this machine
npm run smoke   # drive the real tool once and write the screenshot to .scratch/
```

Two more checks drive the tool against the machine and read the result back, so a
regression in the coordinate mapping or the input path fails loudly instead of producing
a plausible screenshot:

```sh
npm run check:input       # move the cursor, read it back, compare against the mapping
npm run check:click-type  # click and type into a scratch document, then read the text
npm run check:scroll      # scroll a document and read which way the view moved
```

`check:input` is self-verifying: it reads the cursor with the helper before and after, so
a wrong scale factor shows up as a wrong coordinate. `check:click-type` needs a focused
`TextEdit` window and skips rather than clicking into whatever else holds focus.
`check:scroll` asks the Accessibility API for a `TextEdit` document's visible character
range, which is the only way to tell a downward scroll from an upward one — a screenshot
cannot say which way the view moved. That check exists because the scroll sign was
inverted once and nothing noticed.

The suites that do not touch the harness package run even without `npm install`; the
tool-schema suites skip themselves with a note instead of failing.

```
src/
  index.js              the Cordis plugin: registers the tool and the prompt section
  tool.js               the `computer` tool, coordinate state, permission gates
  actions.js            the action vocabulary, schema, and canonicalisation
  keys.js               Codex key/button names → canonical macOS names
  geometry.js           image space ↔ display point mapping
  png.js                PNG IHDR reader
  config.js             defaults and validation
  prompt.js             the system-prompt policy
  exec.js               subprocess helper with timeout and cancellation
  backends/
    index.js            backend selection
    native.js           compile, probe, act, capture
    applescript.js      the reduced fallback
  native/
    computer_helper.m   the Objective-C helper
```

## Verified on

macOS 26.0.1 (arm64), Node 24, with two displays. The native helper compiles, probes
both displays, captures a 2940×1912 PNG of a 1470×956-point Retina display, and reports
that input events are discarded while Accessibility is withheld — which is the correct
answer on a machine where it has not been granted.

## Security

This tool drives the user's real desktop with their real logged-in applications. It is
not a sandbox and does not pretend to be one.

- Screenshots and window contents are **untrusted input**. The prompt section says so,
  but a model can be wrong; the `allowedActions` allow-list is the enforcement point.
- Anything on screen is reachable, including the user's mail, bank, and terminal.
- The helper is a local binary compiled from source in this repository. It is not
  signed with a Developer ID, so it has no special trust beyond the permission you
  grant it.

## License

MIT — see [LICENSE](LICENSE).
