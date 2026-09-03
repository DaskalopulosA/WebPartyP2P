# WebParty P2P — static browser minigames

WebParty P2P is a small proof that realtime multiplayer browser games can live
entirely on GitHub Pages. GitHub serves static HTML, CSS, and JavaScript;
browsers discover one another through Trystero and exchange game traffic over
encrypted WebRTC DataChannels.

There is no application server, database, serverless function, account system,
secret, API key, or paid service operated by this project.

Play the deployed build:
[`https://daskalopulosa.github.io/WebPartyP2P/`](https://daskalopulosa.github.io/WebPartyP2P/)

## Games

### Cloud Hop

Cloud Hop is an original vertical platform race designed for both desktop and
mobile browsers. Bouncing is automatic; players steer left and right to climb a
room-seeded course and race to the 1,500m beacon.

- Desktop: arrow keys or `A` / `D`
- Phone or tablet: hold the large left/right controls, or hold either half of
  the game canvas
- Multiplayer: remote positions, best heights, falls, round resets, and finish
  events travel between browsers; nearby rivals are drawn as live ghosts and
  distant rivals appear as edge markers

The local browser owns its physics, so input stays responsive even if the
network jitters. A compact position update is broadcast at most every 80ms.

### Signal Sprint

The original connectivity demo remains available: race to 25 clicks, taps, or
space-bar presses. Score updates and new rounds synchronize between peers.

## What this proves

- A multiplayer game shelf can be built and hosted as static files.
- A share URL carries both the game and room, for example
  `https://daskalopulosa.github.io/WebPartyP2P/?game=cloud-hop&room=ABC123`.
- Every page load gets a random Trystero peer ID, so each tab is an independent
  player. IP addresses are not application identity.
- One reusable room layer can support games with very different state and input
  needs without putting game rules in networking code.
- Room ID, game protocol, local and remote peer IDs, discovery status, WebRTC
  state, and useful low-frequency events remain visible while playing.

## Architecture

```text
GitHub Pages                     Public Nostr relays
serves static files              exchange encrypted SDP/ICE handshakes
       │                                      │
       ▼                                      ▼
  Browser A  ═══════ encrypted WebRTC DataChannel ═══════  Browser B
             presence + namespaced minigame events
```

The code has four intentionally small layers:

- `src/network.js` owns Trystero rooms, discovery, raw JSON event transport,
  peer lifecycle, and relay/WebRTC diagnostics.
- `src/session.js` owns shared room membership, player identity, presence,
  roster catch-up, and game-message namespacing. It has no game rules.
- `src/games/` owns the catalog and one module per minigame. A game owns its DOM
  or canvas, controls, rules, reconciliation, and cleanup.
- `src/main.js` owns the game shelf, room URL, common arena shell, invite link,
  and debugging panel.

Each game is lazy-loaded, so adding games does not turn the first page into one
large bundle.

### Minigame contract

Add one catalog entry in `src/games/catalog.js`:

```js
{
  id: 'my-game',
  title: 'My Game',
  description: 'One useful sentence.',
  controls: 'How to play',
  load: () => import('./my-game.js')
}
```

The module exports one mount function:

```js
export function mountGame(root, {session, addLog}) {
  // Render into root and subscribe to session events.
  return {
    onSessionChange() {},
    destroy() {}
  }
}
```

The useful session surface is deliberately narrow:

- `session.selfPlayer`, `session.roomId`, and `session.gameId`
- `session.getPlayers()` and `session.getConnectedPeerIds()`
- `session.sendGame(type, data, optionalTarget, options)`
- `session.onGameEvent(listener)` and `session.onPeerEvent(listener)`

Use `{frequent: true}` for high-rate ephemeral updates; the common debug log
keeps those quiet so diagnostics remain readable. This is a practical extension
seam, not a complete framework: common concepts should only move into the
session layer after another real game proves they are shared.

## Discovery, signaling, and P2P traffic

The app uses Trystero's default **Nostr strategy**. When joining a room,
Trystero connects to a redundant selection from its built-in public Nostr relay
list. Those third-party relays help peers find one another and exchange
encrypted WebRTC session descriptions and ICE candidates. This repository does
not deploy or administer them.

After peers connect, application events use encrypted WebRTC DataChannels and
do not pass through Nostr. These include:

- player presence and roster snapshots
- Signal Sprint scores and round resets
- Cloud Hop positions, heights, falls, state snapshots, finishes, and new skies

Static assets still come from GitHub Pages. Nostr still carries discovery and
signaling. Public STUN services selected by Trystero help browsers determine
reachable routes. No TURN service is configured, so game traffic is not relayed
through infrastructure operated for this app.

A room code is a shared namespace and convenience, not strong access control.
Do not use this proof of concept for sensitive data.

## Run locally

Requirements: Node.js 22 or 24 and pnpm 11.

```bash
pnpm install
pnpm dev
```

Open the exact URL Vite prints, normally:

```text
http://localhost:5173/WebPartyP2P/
```

`localhost` is a secure browser context and is suitable for WebRTC. To check
the exact production output:

```bash
pnpm build
pnpm preview
```

The `dist/` directory contains static files only.

## Test with two browser tabs

1. Open the local or deployed site.
2. Choose **Cloud Hop** and select **Create a Cloud Hop room**.
3. Select **Copy invite link** and open it in another tab or private window.
4. Wait for both tabs to say **2 players connected**. Discovery commonly takes
   a few seconds.
5. Move in both tabs. When the players are at similar heights, each browser
   should draw the other player's colored ghost. The live leaderboard should
   update even when they are far apart.
6. Select **New sky** in one tab. Both players should restart on the same new
   course.
7. Return to **Games**, choose **Signal Sprint**, create a room, and verify that
   score and round events still synchronize.

The diagnostics should show a different local peer ID in every tab and list the
other tab as a remote peer.

## Test across two devices

Use the deployed HTTPS page for the cleanest test:

1. Create a room on the first device and send the invite URL to the second.
2. Open it in a current Chrome, Edge, Firefox, or Safari browser.
3. Wait for both devices to show **P2P connected**.
4. On desktop, use the keyboard. On mobile, use the large touch controls.
5. For a stronger NAT test, place one device on Wi-Fi and the other on cellular.

A Vite server exposed to the LAN can also serve the page, but some browsers
restrict APIs on non-HTTPS LAN origins. GitHub Pages avoids that variable.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy.yml` installs dependencies, runs the
production build, uploads only `dist/`, and deploys it with GitHub's official
Pages actions whenever `main` changes. It needs no repository secrets.

One-time repository setting:

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main`, or manually run **Deploy static site to GitHub Pages**.

Vite's base path is `/WebPartyP2P/`, matching the repository name.

## Known WebRTC and game limitations

- There is no TURN fallback. Symmetric NAT, strict carrier-grade NAT,
  enterprise firewalls, VPN policies, or blocked UDP/WebRTC can prevent a
  connection.
- Public Nostr relays can be unavailable, rate-limited, blocked, or change
  behavior. Redundancy helps but does not remove that dependency.
- Peers form a full mesh. This suits a small party, not a large audience.
- State is ephemeral. When every tab leaves, the room disappears.
- Cloud Hop intentionally trusts each browser's physics and wall clock. There
  is no authoritative host, anti-cheat, lag compensation, or clock
  synchronization. Near-simultaneous finishes may be ordered imperfectly.
- Background-tab throttling and mobile sleep can delay updates or disconnect a
  player.
- WebRTC and its discovery/ICE infrastructure can expose network address
  information to connected peers or infrastructure. The app does not read or
  use an IP address as player identity.

## Sensible next steps

1. Playtest Cloud Hop on iOS Safari, Android Chrome, and desktop browsers, then
   tune platform spacing and movement constants from actual device feel.
2. Add a tiny automated contract test for every catalog game: mount, receive an
   event, react to a peer, and destroy cleanly.
3. Measure connection success and latency across home, mobile, and corporate
   networks before committing to a no-TURN product architecture.
4. Add reconnect handling and an optional elected host only when a game truly
   needs authority.
5. Extract shared round reconciliation or input helpers only after a third game
   demonstrates the same need.

## Dependencies

- [Trystero](https://github.com/dmotz/trystero) provides peer discovery and its
  small WebRTC room/action API.
- [Vite](https://vite.dev/) bundles browser modules into static production
  files. It is a build tool and is not a deployed server.

No runtime analytics, web fonts, asset CDNs, paid services, credentials, or
operator-run backend infrastructure are used.
