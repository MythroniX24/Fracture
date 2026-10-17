# Controls

## Desktop (keyboard + mouse)

| Action | Input | Notes |
| --- | --- | --- |
| Move | `W` `A` `S` `D` or arrow keys | Camera-relative; moving diagonally is normalised (never faster) |
| Look / aim | Mouse move | Click the canvas to lock the pointer; the screen centre is the aim |
| Jump | `Space` | Held jump buffers a jump; release early to shorten the hop |
| Dodge | `Shift` (left or right) | Grounded only, 0.22 s burst, 1.2 s cooldown, not invulnerable |
| Punch | Left mouse button | 15 damage, 2.2 m reach, 0.45 s cooldown |
| Gravity Shot | Right mouse button | 8 damage, pulls the target to you, 4 s cooldown, 25 energy |
| Shockwave | `Q` | 12 damage in a 5 m ring, 7 s cooldown, 35 energy |
| Platform Break | `E` | 30 platform damage, 2 charges per life |
| Pause / settings | `Esc` | Releases local input and pointer lock; **the match keeps running** |

Move, look and aim never require the pointer to be locked to keep playing, but mouse look only works
while locked. `Esc` releases the lock (browser behaviour), so click again to resume looking.

## Touch

| Element | Behaviour |
| --- | --- |
| Left stick | Move (analog, dead-zone tolerant, capped to a 46 px radius) |
| Right half of the screen | Drag anywhere to look/aim; delta-based, so the finger never occludes the target |
| Jump | On-screen button (hold for a full hop, release early to shorten) |
| Dodge | On-screen button |
| Punch | Large primary button |
| Gravity | On-screen button |
| Shockwave | On-screen button |
| Break | On-screen button; the highlighted platform is the target |

Buttons are 58–96 px (`clamp(<n>px, <n>vmin, <n>px)`, so they scale with the viewport) and spread
across the corners so multi-touch (stick + look + ability) works at once. Punch and Jump get the
largest targets because they are pressed dozens of times a minute. Every ability button carries its
own readiness: a cooldown veil sweeps down as it comes back, the remaining seconds are printed on the
button, `Break` shows its remaining charges, and Gravity/Shockwave show their energy cost when you
cannot afford them. During a match the game canvas sets `touch-action: none` and `user-select: none`,
and the touch areas call `preventDefault`, so browser scrolling, pull-to-refresh, double-tap zoom and
text selection cannot interrupt play. Menus keep normal touch behaviour.

### Fullscreen and landscape

Tapping **Create room** or **Join** on a touch device takes the browser fullscreen and asks the OS to
lock the orientation to landscape, then requests a screen wake lock so the display cannot dim during a
match. All three are best-effort:

- If the browser has no orientation lock (iOS Safari) the game still goes fullscreen, and if the
device is held upright a **Rotate to landscape** prompt covers the screen with a button that retries.
  The arena is far wider than it is tall, so portrait play would hide half the field and stack the
  ability buttons over the joystick.
- Desktop is untouched: no fullscreen request, no prompt, mouse and keyboard as documented above.
- The prompt disappears automatically when the device is rotated — it watches the viewport, not a
  one-off check at load.

## Aiming at platforms

Platform Break targets the **destructible platform under the centre reticle within 9 m**. Aim at a
platform (look down for a causeway below you) and a bronze wireframe highlight appears during
targeting, with the platform's name under the reticle. If nothing valid is under the reticle the
attempt is refused with a short reason and **no charge is consumed**.

On touch, the camera centre is the aim ray, so the same highlight and rule apply.

## HUD reference

| Element | Location | Meaning |
| --- | --- | --- |
| Timer | Top centre | Remaining match time (turns red under 30 s) |
| Phase label | Under the timer | `Get ready`, `Free-for-all · 5:00`, `Match over` |
| Connection | Top left | Online / reconnecting / offline, ping, optional FPS |
| Scoreboard | Top right | Every fighter: colour, name, health bar, score |
| Health / energy bars | Bottom left | Exact values, colour-coded by danger |
| Ability tiles | Bottom right | Readiness, remaining cooldown, Break charges |
| Crosshair | Centre | Turns bronze when an enemy is inside punch reach |
| Target hint | Under the crosshair | Name of the platform Platform Break would destroy |
| Event feed | Right | Eliminations, falls, platform collapses, phase messages |
| Respawn overlay | Centre | Countdown while downed |
| Denial message | Lower centre | Why an ability was refused (cooldown, energy, charges, no target) |

## Settings (persisted per browser)

| Setting | Default | Effect |
| --- | --- | --- |
| Look sensitivity | 1.00× | 0.3×–2.5× mouse/touch look rate |
| Volume | 60 % | Master gain for the procedural audio |
| Mute all audio | off | Mutes without forgetting the volume |
| Reduce motion | from `prefers-reduced-motion` | Fewer particles, no camera shake, snappier camera |
| Show FPS counter | off | Adds a smoothed FPS readout next to the ping |

Settings are stored in `localStorage` under `fracture.settings.v1`.

## Difficulty / comfort notes

- Spawn protection is visible as a pulsing shield and blocks incoming damage for 1.5 s.
- Knockback is capped so repeated hits cannot fling a player at absurd speeds.
- The respawn point is chosen to be the one farthest from living opponents.
- Vertical camera angle is clamped to ±83° and never inverts.
- The camera pulls in when geometry would clip through the view.
