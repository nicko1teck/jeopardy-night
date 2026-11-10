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

- **TV**: open `http://your-server:3000/`. A TV that doesn't know the host key shows a
  4-digit code: type it into **Connect a TV** on your host cards page and that TV becomes the host
  board (it remembers). Backups: type the key into the TV's box, or open `/?key=...` once. The key
  never stays in the address bar. Players who open this page are told to go to `/buzz`.
- **Phones**: `http://your-server:3000/buzz`, then the code shown on the TV.
- **Host cards** (your phone): `http://your-server:3000/host`, then the host key once. Also where you **Connect a TV**. It shows the
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
5. Pick a clue. The buzzers open the moment it appears, and a countdown shows how long is
   left to buzz. When a team buzzes, their name lights up gold and a second countdown starts
   for their answer. When it runs out you hear the time's-up sound, but you still judge with
   ✓ or ✗. A wrong answer reopens the buzzers for the other team.
   - **Undo buzz:** someone jumped the gun? Press **Undo buzz**. The buzzers reopen and no
     score changes.
   - **Overrule:** on the answer screen, each team has ✓ / ✗ / – for that clue. Change any of
     them and the score fixes itself. Already back on the board? Host panel →
     **Fix last clue's scoring**.
6. **Daily Double**: pick the team that found it. Their phone asks for a wager.
7. **Final Jeopardy**: phones take wagers, then answers. Start the 45-second clock,
   then reveal each team's answer and judge it.

**Controller**: point and press A, or use the D-pad and A. **B**, **Menu** or **Esc**
opens the host panel (time to buzz, time to answer, fix scores, skip a round, end the game).

**No server?** The board also works as plain static files, on S3 for example. Buzzers
are off then: teams answer out loud and you judge.

## Adding a game

Drop one `.json` file into `public/games/` and it appears on the TV's home screen. Nothing
else to edit, and no restart. (On the server, that means push, then the server pulls it.)

The smallest board needs only a `subject`, the `rounds`, and a `final`. Start from
`public/games/_template.json` (files starting with `_` are never listed):

```json
{
  "subject": "Mission Impossible",
  "edition": "Game 1",
  "rounds": [
    { "categories": [ { "name": "Gadgets", "clues": [ { "q": "Clue", "a": "What is …?" } ] } ] }
  ],
  "final": { "category": "…", "clue": "…", "answer": "…" }
}
```

- **`subject`** sets the title everywhere: "Mission Impossible" shows as
  **Mission Impossible Jeopardy** on the TV, phones and host cards. Use `"title"` instead
  to spell the whole title yourself.
- **`edition`** (optional) tells boards on the same subject apart, e.g. "Game 2".
- **Clues**: `q` is the clue, `a` the response. `"dd": true` makes it a Daily Double.
- **Categories**: `"kids": true` makes it a youngest-players category. Every category in a
  round needs the same number of clues. Up to 8 categories per round.
- **Values** default to 200–1000 in round 1 and 400–2000 in round 2. Set `"values"` on a
  round to change them, and `"name"` to rename it.
- **Youngest-players categories** (`"kids": true`) show "Youngest player on each team only"
  on their clues, and only there. Change the wording for a board with
  `"rules": { "kids": "..." }`.

### Difficulty scale

Every board follows the same climb, so the dollar values mean something:

| Value | Who should get it |
|---|---|
| R1 $200 | Anyone who has read or watched it once: main characters, the big premise |
| R1 $400 | Major plot points |
| R1 $600 | Important secondary characters, objects, places |
| R1 $800 | Details an attentive reader remembers |
| R1 $1000 | Specific moments, minor names |
| R2 $400–800 | About R1 $600–1000: Double Jeopardy starts where Round 1 left off |
| R2 $1200–1600 | Re-reader details |
| R2 $2000 | Deep trivia, still straight from the story |
| Youngest-players categories | Same climb, about two notches easier |
| Final Jeopardy | Hard but fair: gettable with thought by anyone who knows the story |

Within a category, each clue is clearly harder than the one above it. Daily Doubles go on the
$800–$1600 rows of regular categories (never a youngest-players category): one in Round 1, two in
Round 2.

If a file has a mistake, the TV home screen says which file and what's wrong, and skips it.

`public/games/index.json` is only used when the board runs without the server (plain static
hosting). With the server, ignore it.

## Saved games and crashes

The server saves the game to `~/.jeopardy-night/room.json` (outside the app folder) as it
changes, and the TV sends it a copy of the board too. So:

- **Server restart, crash or redeploy:** the game carries on. Phones reconnect by themselves
  with the same room code; nobody rejoins.
- **TV crash or reload:** open the TV link and press **Resume**. It works even from a
  different browser, because the server has a copy.
- **End game** in the host panel clears the saved copy.

Set `DATA_DIR` to save somewhere else.

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
| `final-think.mp3` | Final Jeopardy think music (loops if shorter than the 45-second clock) |
| `theme.mp3` | theme song: when the game starts (stops at the first pick), and during Final Jeopardy's clock if there's no `final-think.mp3` |
| `winner.mp3` | winner fanfare |

## Game history (database)

Every game is saved to MariaDB/MySQL: the teams and scores, every clue played (with its text,
who buzzed in what order, Daily Double wagers) and each team's result on it, the host's +/-
adjustments, and Final Jeopardy wagers, typed answers and results. Host fixes (overruling a call,
"Fix last clue's scoring", editing a Final wager) **replace** the earlier result rather than adding
a second one, so the database always matches the scoreboard.

It's optional: with no database settings the game plays exactly the same and saves no history.
A database problem never stops a game; it's logged and play carries on.

**Settings** live outside the app folder so they never reach git, in `~/.jeopardy-night/db.json`:

```json
{ "host": "localhost", "user": "jeopardy", "password": "...", "database": "jeopardy" }
```

(or the environment variables `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`). The server creates
the tables itself on startup.

| Table | One row per |
| --- | --- |
| `games` | game played: file, title, start/end, finished or abandoned, winner, the Final clue |
| `teams` | team in a game, with its score |
| `clues` | clue played: round, category, value, question and answer, Daily Double and wager, buzz order |
| `clue_results` | team on a clue: 1 right, -1 wrong, 0 no answer, and the points |
| `final_results` | team in Final Jeopardy: wager, typed answer, result |
| `score_adjustments` | each +/- from the host panel |
| `clue_stats` (a view) | each clue across every game: times played, answered right, missed, nobody got it |

## Files

```
server.js            the server
db.js                game history: saves every game to the database
package.json         "npm start" runs the server; no dependencies
public/index.html    TV board
public/buzz.html     phone buzzer
public/host.html     host cards: your private answer view
public/sounds.js     sound effects shared by both
public/sounds/       optional custom sound clips
public/games/        question files, one per game (plus _template.json)
```
