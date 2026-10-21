# Design

Pal's visual design has one source of truth: the **[Pal — Quiet redesign](https://claude.ai/artifact/TpUipcd4EWLE1QibwEdQHu)**
design canvas. UI changes start there, and `web/src` implements it. When the app and the canvas disagree, the canvas
wins, or the canvas is updated first, so the two are never left to drift on purpose.

## The canvas

| Page                                | What it holds                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1 · Desktop — sign in & onboarding  | Sign in; onboarding: provider, API key / ChatGPT sign-in, model, internet tools, first project    |
| 2 · Desktop — workspace             | Chat + Changes, chat + terminal, right panels, menus, Settings (incl. Extensions), chat states, light |
| 3 · Mobile                          | Sign in, chat, projects drawer, search, tools sheet, model sheet, Changes, panels, terminal, Settings |
| 4 · Brand & tokens                  | **Quiet — tokens & components** (the token reference below) and the refined Pal mark             |
| 5 · Logo explorations               | Rounds 1–5 of the mark; "Refined" is the current one                                             |
| 6–9 · Themes                        | Theme picker (the logo follows the theme) and the Retro, Classic and Cyberpunk themes            |

Desktop frames are 1440 px wide, phone frames 390 × 844.

## Quiet

Neutral greys do the work. Blue appears only where you act: send, approve, focus, and the eyes of the mark.

### Color tokens

The tokens map to `web/src/app.css` (`:root` for dark, `[data-theme="light"]` for light).

| Token       | Dark      | Light     | Use                                      |
| ----------- | --------- | --------- | ---------------------------------------- |
| `--bg0`     | `#141517` | `#FAFAFB` | deepest surface                          |
| `--bg1`     | `#17181B` | `#F3F3F5` |                                          |
| `--bg2`     | `#1B1C1F` | `#FFFFFF` | cards, fields                            |
| `--bg3`     | `#222327` | `#EBEBEE` | hover, secondary buttons                 |
| `--bg4`     | `#26272C` | `#E2E2E6` | selected, pressed                        |
| `--line`    | `#222327` | `#E2E2E6` | borders                                  |
| `--line2`   | `#2A2B30` | `#D4D4D9` | stronger borders, dividers               |
| `--tx`      | `#E7E7EA` | `#18191C` | text                                     |
| `--tx2`     | `#A2A3AA` | `#4F5058` | secondary text                           |
| `--tx3`     | `#8E8F97` | `#62636B` | labels, meta, diff gutters               |
| `--primary` | `#4A6FCC` | `#3E63C2` | primary buttons; hover darkens (`#3F62BD`) |
| `--ac`      | `#8FAAEF` | `#3E63C2` | accent, the mark's eyes                  |
| `--focus`   | `#5B7BD0` | `#3E63C2` | 2 px focus outline, offset 2             |
| `--ok`      | `#93BFA5` | `#276847` | done                                     |
| `--wa`      | `#C9A66B` | `#8A6420` | waiting                                  |
| `--er`      | `#C99199` | `#A8424F` | failed                                   |
| `--syn-k`   | `#9DB1E6` | `#3550A8` | syntax: keywords                         |
| `--syn-s`   | `#A9C29B` | `#4C7A3A` | syntax: strings                          |

Text keeps at least 4.5:1 contrast on every surface.

### Type, radius and spacing

- **Type:** Bricolage Grotesque for the wordmark and titles; Geist 400 / 550 for UI; Geist Mono for code, paths and the
  terminal. Scale: 30 title, 20 section, 15 chat body, 14 UI base, 13 secondary and buttons, 12 labels and meta.
- **Radius:** 8 buttons and rows, 12 fields and cards, 16 panels and composer, 24 sheets, full for send and avatars.
- **Spacing:** 4 px base: 4, 8, 12, 16, 24, 32, 48.

### Components

- Buttons are 34 px high: secondary on the left (Deny), primary on the right (Approve once).
- Send is a 32 px round primary button; panel buttons are 34 px icon buttons with a tooltip.
- Status is a 6 px dot plus a word: Waiting (`--wa`), Done (`--ok`), Failed (`--er`), Offline (`--tx3`).
- Icons are 16 px stroke icons, 1.6 stroke, round caps and joins.

## Where the app differs today

Measured against `web/src/app.css` on 2026-10-21:

- **Dark:** 15 of 18 tokens match. `--bg0` (`#111214`), `--bg1` (`#141517`) and `--tx3` (`#85868E`) differ.
- **Light:** 1 of 18 tokens matches; the light theme still uses the earlier palette and needs to move to the values
  above.
- **Themes:** Retro, Classic and Cyberpunk and the theme picker are designed but not implemented.

Update this section when either side changes.
