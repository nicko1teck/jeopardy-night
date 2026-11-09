# Jeopardy Night

Family Jeopardy on the living-room TV. The board runs in a browser (Edge on the Xbox),
the host drives it with the controller, and each team's phones are their buzzers.

## How it fits together

```
 Xbox (Edge)  ──  index.html  ──┐
                                 ├──  server.js (Node, on EC2)
 Phones       ──  buzz.html   ──┘
```

- **server.js** serves the pages and keeps the live room state: the room code, teams,
  who buzzed first, wagers and Final Jeopardy answers. It uses no npm packages.
- **Server → screens**: Server-Sent Events (`/events`), a one-way stream that pushes
  every change to the TV and phones as it happens.
- **Screens → server**: ordinary POST requests (`/api/buzz`, `/api/wager`, `/api/answer`, `/api/host`).
- **Who's first**: Node handles one request at a time, so the first buzz to reach the
  server wins and every later one is told it was late.
- **Trust**: the TV and the host cards page prove they're the host with `HOST_KEY`.
  Phones prove they're in the room with the 4-letter code shown on the TV.

The TV keeps the board and the scores. It sends the scores to the server so phones can show them.

## Run it

Needs Node 18 or newer.

```
HOST_KEY=pick-a-secret PORT=3000 node server.js
```

- `HOST_KEY` is the password in the TV's link. Without it, a random one is made each
  start and printed in the console.
- `PORT` is the port to listen on (default 3000).

Then:

- **TV**: `http://your-server:3000/?key=pick-a-secret`. The key is remembered after the first visit.
- **Phones**: `http://your-server:3000/buzz`, then the code shown on the TV.
- **Host cards** (your phone): `http://your-server:3000/host?key=pick-a-secret`. It shows the
  answer to whatever clue is on the TV, who buzzed in, and the scores. It needs the host key,
  and the server never sends answers to players' phones. "Hide answers until I tap" blurs
  them for when the kids are sitting beside you.

Behind nginx, the live stream needs buffering off for `/events`. The server already
sends `X-Accel-Buffering: no`, which nginx respects.

## Playing

1. On the TV, pick a game. The lobby shows a room code.
2. Each team opens `/buzz` on a phone, enters the code, and creates a team. A second
   phone can join an existing team. A team with no phone can be added on the TV.
3. Press **Start the game**.
4. Each round starts with the categories covered, like the show. Click each one to
   unveil it (or "Reveal all categories" in the host panel); clues unlock once all six
   are showing.
5. Pick a clue. The buzzers open the moment it appears, so teams can buzz while you're
   still reading. Whoever buzzes first gets the gold banner; judge with ✓ or ✗. A wrong
   answer reopens the buzzers for the other team. If nobody buzzes in time (20 seconds
   to start with), it's time's up; you can reopen them. Change the time with
   **Time to buzz** in the host panel, even mid-game.
6. **Daily Double**: pick the team that found it. Their phone asks for a wager.
7. **Final Jeopardy**: phones take wagers, then answers. Start the 30-second clock,
   then reveal each team's answer and judge it.

**Controller**: point and press A, or use the D-pad and A. **B**, **Menu** or **Esc**
opens the host panel (time to buzz, fix scores, skip a round, end the game).

**No server?** The board also works as plain static files, on S3 for example. Buzzers
are off then: teams answer out loud and you judge.

## Adding a game

1. Copy `public/games/game1.json` to a new file, such as `lotr1.json`, and change the
   questions. `"dd": true` marks a Daily Double; `"kids": true` marks a youngest-players category.
2. Add a line to `public/games/index.json`:
   `{ "id": "lotr1", "title": "Lord of the Rings Jeopardy · Game 1", "file": "lotr1.json" }`

No code changes needed.

## Sounds

Every action has a built-in sound made in the browser. To use your own clip instead,
put an `.mp3` with the slot's name in `public/sounds/`. Silence at the start of a clip is
trimmed automatically, so it plays the instant the action happens. (The threshold is
`SILENCE_THRESHOLD` at the top of `public/sounds.js`; raise it if a clip has background hiss.)

The slots:

| File | Plays when |
| --- | --- |
| `board-fill.mp3` | a round's board appears |
| `category-reveal.mp3` | a category is unveiled |
| `pick.mp3` | a clue is picked |
| `reveal.mp3` | clue text appears |
| `buzz-in.mp3` | a team buzzes in (TV) |
| `phone-buzz.mp3` | a phone's buzzer is pressed |
| `too-early.mp3` | someone buzzed too soon |
| `times-up.mp3` | no buzz in time, or the Final clock ends |
| `right.mp3` / `wrong.mp3` | judging |
| `daily-double.mp3` | Daily Double found |
| `team-joined.mp3` | a team joins the lobby |
| `round-end.mp3` | end of a round |
| `final-think.mp3` | Final Jeopardy think music (30 seconds) |
| `winner.mp3` | winner fanfare |

## Files

```
server.js            the server
package.json         "npm start" runs the server; no dependencies
public/index.html    TV board
public/buzz.html     phone buzzer
public/host.html     host cards: your private answer view
public/sounds.js     sound effects shared by both
public/sounds/       optional custom sound clips
public/games/        question files and the game list
```
