# Signal Sprint — static WebRTC party-game POC

Signal Sprint is a deliberately tiny multiplayer button race. Players join the
same room, race to 25 taps, see each other's scores update in real time, and can
start a synchronized new round.

The important part is not the game: the production application is only static
HTML, CSS, and JavaScript. GitHub Pages serves those files, while browsers send
game events directly to one another over encrypted WebRTC DataChannels.

Expected Pages URL:
[`https://daskalopulosa.github.io/WebPartyP2P/`](https://daskalopulosa.github.io/WebPartyP2P/)

## What this proves

- A multiplayer browser game can be built and hosted as static files.
- There is no application server, database, serverless function, account
  system, secret, or API key.
- A room can be shared as a short code or a URL such as
  `https://daskalopulosa.github.io/WebPartyP2P/?room=ABC123`.
- Each page load gets a random Trystero peer ID, so every tab is an independent
  player. IP addresses are never used as application identity.
- Connected players, peer IDs, room ID, discovery state, transport, and recent
  network events are visible in the diagnostics panel.

## Architecture

```text
GitHub Pages                 Public Nostr relays
serves static files          exchange encrypted SDP/ICE handshakes
       │                                  │
       ▼                                  ▼
  Browser A  ═════ encrypted WebRTC DataChannel ═════  Browser B
             presence, score, snapshot, round-reset events
```

The source is intentionally split at one boundary:

- `src/network.js` owns peer discovery, Trystero rooms, WebRTC peer lifecycle,
  event transport, and network diagnostics.
- `src/main.js` owns room URLs, players, scores, round reconciliation, and the
  interface. It only sees small named JSON events.

This is separation for a future game layer, not an attempted framework.

### Shared state

Each player owns a monotonically increasing score. Remote peers keep the
largest score they have seen for each peer, making duplicated or reordered
messages harmless. When a peer connects, existing peers send a snapshot so the
new arrival catches up. New rounds use a `(version, peerId)` tuple so
simultaneous reset messages settle on the same round without a server clock.

There is deliberately no authoritative host and no persistence. When every tab
leaves, the room state disappears.

## Discovery and signaling

The app uses Trystero's default **Nostr strategy**. On joining a room, Trystero
connects to a small redundant selection from its built-in list of public Nostr
relays. Those relays are third-party public infrastructure; this project does
not deploy or administer them.

The relays only help browsers find each other and exchange WebRTC session
descriptions and ICE candidates. Trystero encrypts that handshake material with
a key derived from the public app ID and room ID. A room code is therefore a
namespace and convenience, **not** strong access control.

WebRTC then uses ICE and public STUN services selected by Trystero to attempt a
direct connection through NAT. No TURN relay is configured, because a TURN
service would relay game traffic and weaken the zero-infrastructure proof.

## What traffic is actually peer-to-peer?

After connection, these application events travel browser-to-browser through
WebRTC DataChannels and do not pass through Nostr:

- player presence and nickname
- score updates
- catch-up snapshots
- new-round events

They are encrypted in transit by WebRTC (DTLS). Static assets still come from
GitHub Pages; Nostr relays still carry discovery/signaling; STUN servers help
determine reachable network addresses. As with WebRTC generally, connected
peers and some discovery/ICE infrastructure may learn network address
information. The app does not read an IP address or use one as player identity.

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

`localhost` is treated as a secure browser context, so it is suitable for this
WebRTC POC. To check the exact production output locally:

```bash
pnpm build
pnpm preview
```

The production bundle is written to `dist/` and contains static files only.

## Test with two browser tabs

1. Open the local or deployed site and select **Create a fresh room**.
2. Select **Copy invite link**.
3. Paste the link into a second tab or private window.
4. Wait until both tabs say **2 players connected**. Discovery commonly takes
   a few seconds.
5. Tap **Mash it** in either tab. The same score should appear quickly in both.
6. Select **New round** in one tab. Both scoreboards should reset.
7. Compare the diagnostics: each tab has a different peer ID and lists the
   other tab as a remote peer.

If testing repeatedly, use a new room code or fully close old tabs so stale
peers are not confused with the current test.

## Test across two devices

The most reliable test is the deployed HTTPS site:

1. Create a room on the first device.
2. Send the invite URL to the second device.
3. Open it in a current Chromium, Firefox, or Safari browser.
4. Wait for both devices to show **P2P connected**, then race.
5. For a stronger NAT test, put one device on Wi-Fi and the other on cellular.

A development server exposed to the LAN can also serve the page, but browsers
may restrict some APIs on a non-HTTPS LAN origin. GitHub Pages avoids that
variable.

## Deploy to GitHub Pages

The workflow in `.github/workflows/deploy.yml` installs dependencies, runs the
production build, uploads only `dist/`, and deploys it using GitHub's official
Pages actions whenever `main` changes. It needs no repository secrets.

One-time repository setting:

1. Open **Settings → Pages** in the GitHub repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main`, or run **Deploy static site to GitHub Pages** manually from
   the Actions tab.

GitHub Pages is free for a public repository. Vite's base path is fixed to
`/WebPartyP2P/`, matching this repository name.

## Known WebRTC and NAT limitations

- There is no TURN fallback. Peers behind symmetric NAT, strict carrier-grade
  NAT, enterprise firewalls, VPN policies, or networks that block UDP/WebRTC
  may fail to connect. The diagnostics will remain in discovery or report a
  join error.
- Public Nostr relays can be unavailable, rate-limited, blocked, or change
  behavior. Trystero uses redundant relays, but this is still an external
  availability dependency.
- A short room code is discoverable and is not authentication. Anyone who knows
  it can attempt to join. Do not send sensitive data in this POC.
- State is ephemeral and peer-reconciled. There is no late-join history after
  all existing peers leave, host authority, moderation, or anti-cheat.
- Every player connects to every other player, so the mesh is appropriate for a
  small party room, not a large audience.
- Background-tab throttling and mobile sleep can delay events or disconnect a
  peer.

## Sensible next steps

1. Measure connection success and latency across several home, mobile, and
   corporate networks before choosing this architecture for a real game.
2. Define a small versioned game protocol around the existing network boundary.
3. Add optional room passwords for stronger signaling encryption and admission
   knowledge, while keeping in mind that shared links can still leak them.
4. Decide whether broader connectivity justifies an optional TURN service and
   its cost/operations trade-off.
5. Add host election, reconnect handling, and game-specific validation only
   when a real minigame requires them.
6. Add automated multi-browser tests for room join, score convergence, reset,
   and disconnect/reconnect behavior.

## Dependency choices

- [Trystero](https://github.com/dmotz/trystero) provides peer discovery and a
  small WebRTC room/action API.
- [Vite](https://vite.dev/) bundles the browser modules into static production
  files. It is a build tool only and is not present as a deployed server.

No runtime analytics, fonts, CDNs, paid services, credentials, or operator-run
infrastructure are used.
