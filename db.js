'use strict';
// Game history: every game, team, clue, result and Final Jeopardy answer, saved to MariaDB/MySQL.
//
// Optional. With no database settings (or no mysql2 package installed) the game runs exactly
// as before and simply saves no history. A database problem never stops a game: errors are
// logged and the game carries on.
//
// Settings come from environment variables, or from db.json in the data folder
// (~/.jeopardy-night/db.json), which lives outside the app folder so it's never in git:
//   { "host": "localhost", "user": "jeopardy", "password": "...", "database": "jeopardy" }
//
// The TV sends a "record" each time something worth keeping happens. Every record carries the
// game's play ID, so writes are upserts: a host fix (overruling a call, fixing the last clue,
// editing a Final wager) replaces the earlier row instead of adding a second one.

const fs = require('fs');
const path = require('path');

let mysql = null;
try { mysql = require('mysql2/promise'); } catch (e) { /* not installed: history stays off */ }

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS games (
    id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    play_id        VARCHAR(40)  NOT NULL UNIQUE,          -- made by the TV when a game starts
    game_file      VARCHAR(120) NOT NULL,                 -- e.g. narnia-1.json
    game_id        VARCHAR(120) NOT NULL,
    title          VARCHAR(200) NOT NULL,
    edition        VARCHAR(200) NOT NULL DEFAULT '',
    started_at     DATETIME     NOT NULL,                 -- UTC
    ended_at       DATETIME     NULL,
    status         ENUM('playing','finished','abandoned') NOT NULL DEFAULT 'playing',
    winner         VARCHAR(200) NULL,                     -- team name; ties joined with " & "
    final_category VARCHAR(200) NULL,
    final_clue     TEXT         NULL,
    final_answer   TEXT         NULL
  )`,
  `CREATE TABLE IF NOT EXISTS teams (
    game_id    INT UNSIGNED NOT NULL,
    team_index TINYINT UNSIGNED NOT NULL,
    name       VARCHAR(60)  NOT NULL,
    score      INT          NOT NULL DEFAULT 0,           -- latest score; final score once the game ends
    PRIMARY KEY (game_id, team_index),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS clues (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    game_id      INT UNSIGNED NOT NULL,
    clue_key     VARCHAR(200) NOT NULL,                   -- same clue in every game: file|round|category|row
    round_index  TINYINT UNSIGNED NOT NULL,
    round_name   VARCHAR(60)  NOT NULL,
    cat_index    TINYINT UNSIGNED NOT NULL,
    category     VARCHAR(200) NOT NULL,
    clue_index   TINYINT UNSIGNED NOT NULL,
    value        INT          NOT NULL,                   -- board value
    question     TEXT         NOT NULL,                   -- as it read when played
    answer       TEXT         NOT NULL,
    daily_double BOOLEAN      NOT NULL DEFAULT FALSE,
    dd_team      TINYINT UNSIGNED NULL,
    wager        INT          NULL,                       -- Daily Double wager
    buzz_order   VARCHAR(60)  NOT NULL DEFAULT '',        -- team numbers in the order they won the buzz, e.g. "2,0"
    time_up      BOOLEAN      NOT NULL DEFAULT FALSE,     -- nobody buzzed in time
    answer_shown BOOLEAN      NOT NULL DEFAULT FALSE,
    picked_at    DATETIME     NOT NULL,
    updated_at   DATETIME     NOT NULL,
    UNIQUE KEY one_per_game (game_id, round_index, cat_index, clue_index),
    KEY by_clue (clue_key),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS clue_results (
    clue_id    INT UNSIGNED NOT NULL,
    team_index TINYINT UNSIGNED NOT NULL,
    result     TINYINT      NOT NULL,                     -- 1 right, -1 wrong, 0 didn't answer
    points     INT          NOT NULL,                     -- what it did to the score
    PRIMARY KEY (clue_id, team_index),
    FOREIGN KEY (clue_id) REFERENCES clues(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS final_results (
    game_id    INT UNSIGNED NOT NULL,
    team_index TINYINT UNSIGNED NOT NULL,
    wager      INT          NULL,
    response   VARCHAR(200) NULL,                         -- what the team typed on their phone
    result     TINYINT      NULL,                         -- 1 right, -1 wrong, NULL not judged yet
    points     INT          NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, team_index),
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS score_adjustments (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    game_id    INT UNSIGNED NOT NULL,
    team_index TINYINT UNSIGNED NOT NULL,
    delta      INT          NOT NULL,                     -- the host's +/- from the host panel
    made_at    DATETIME     NOT NULL,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  )`,
  // How each clue does across every game it's been played in.
  `CREATE OR REPLACE VIEW clue_stats AS
   SELECT c.clue_key,
          MAX(c.category) AS category,
          MAX(c.question) AS question,
          MAX(c.answer)   AS answer,
          COUNT(DISTINCT c.id) AS times_played,
          COUNT(DISTINCT CASE WHEN r.result = 1  THEN c.id END) AS times_answered_right,
          COUNT(DISTINCT CASE WHEN r.result = -1 THEN c.id END) AS times_someone_missed,
          COUNT(DISTINCT c.id) - COUNT(DISTINCT CASE WHEN r.result = 1 THEN c.id END) AS times_nobody_got_it
     FROM clues c LEFT JOIN clue_results r ON r.clue_id = c.id
    GROUP BY c.clue_key`,
];

let pool = null;
let ready = Promise.resolve();
let chain = Promise.resolve(); // records are written one at a time, in the order they arrive

function settings(dataDir) {
  const env = process.env;
  if (env.DB_NAME) {
    return { host: env.DB_HOST || 'localhost', user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME };
  }
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8')); } catch (e) { return null; }
}

function init(dataDir) {
  const cfg = settings(dataDir);
  if (!mysql || !cfg || !cfg.database) {
    console.log(`Game history: off (${!mysql ? 'mysql2 is not installed' : 'no database settings'}).`);
    return;
  }
  pool = mysql.createPool({
    host: cfg.host || 'localhost', user: cfg.user, password: cfg.password, database: cfg.database,
    connectionLimit: 3, timezone: 'Z',
  });
  ready = (async () => {
    for (const sql of SCHEMA) await pool.query(sql);
    console.log(`Game history: saving to database "${cfg.database}".`);
  })().catch((e) => {
    console.warn('Game history: off, the database could not be set up:', e.message);
    pool = null;
  });
}

const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
const intOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const now = () => new Date();

async function write(rec) {
  if (!pool || !rec || !rec.play || typeof rec.play.id !== 'string' || !rec.play.id) return;
  const p = rec.play;
  const teams = Array.isArray(rec.teams) ? rec.teams.slice(0, 8) : [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // The game: created on its first record, found again on every later one.
    await conn.query(
      `INSERT INTO games (play_id, game_file, game_id, title, edition, started_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title)`,
      [str(p.id, 40), str(p.gameFile, 120), str(p.gameId, 120), str(p.title, 200), str(p.edition, 200), now()]);
    const [[game]] = await conn.query('SELECT id FROM games WHERE play_id = ?', [str(p.id, 40)]);
    const gid = game.id;

    // Teams and their current scores.
    for (let t = 0; t < teams.length; t++) {
      await conn.query(
        `INSERT INTO teams (game_id, team_index, name, score) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), score = VALUES(score)`,
        [gid, t, str(teams[t].name, 60), int(teams[t].score)]);
    }

    // A clue: its row is replaced, and its results are rewritten from scratch,
    // so the database always matches the latest call (host fixes included).
    if (rec.clue) {
      const c = rec.clue;
      const key = [str(p.gameFile, 120), int(c.round), int(c.c), int(c.i)].join('|');
      await conn.query(
        `INSERT INTO clues (game_id, clue_key, round_index, round_name, cat_index, category, clue_index, value,
                            question, answer, daily_double, dd_team, wager, buzz_order, time_up, answer_shown,
                            picked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), question = VALUES(question), answer = VALUES(answer),
           daily_double = VALUES(daily_double), dd_team = VALUES(dd_team), wager = VALUES(wager),
           buzz_order = VALUES(buzz_order), time_up = VALUES(time_up), answer_shown = VALUES(answer_shown),
           updated_at = VALUES(updated_at)`,
        [gid, key, int(c.round), str(c.roundName, 60), int(c.c), str(c.category, 200), int(c.i), int(c.value),
          str(c.q, 5000), str(c.a, 5000), !!c.dd, intOrNull(c.ddTeam), intOrNull(c.wager),
          (Array.isArray(c.buzzes) ? c.buzzes.map(int).join(',') : '').slice(0, 60), !!c.timeUp, !!c.shown,
          now(), now()]);
      const [[clue]] = await conn.query(
        'SELECT id FROM clues WHERE game_id = ? AND round_index = ? AND cat_index = ? AND clue_index = ?',
        [gid, int(c.round), int(c.c), int(c.i)]);
      await conn.query('DELETE FROM clue_results WHERE clue_id = ?', [clue.id]);
      const results = Array.isArray(c.results) ? c.results.slice(0, teams.length || 8) : [];
      const each = c.dd ? int(c.wager) : int(c.value);
      for (let t = 0; t < results.length; t++) {
        const r = Math.max(-1, Math.min(1, int(results[t])));
        await conn.query('INSERT INTO clue_results (clue_id, team_index, result, points) VALUES (?, ?, ?, ?)',
          [clue.id, t, r, r * each]);
      }
    }

    // Final Jeopardy: the clue itself, then each team's wager, typed answer and result.
    if (rec.final) {
      const f = rec.final;
      await conn.query('UPDATE games SET final_category = ?, final_clue = ?, final_answer = ? WHERE id = ?',
        [str(f.category, 200), str(f.q, 5000), str(f.a, 5000), gid]);
      for (const row of Array.isArray(f.rows) ? f.rows.slice(0, 8) : []) {
        const wager = intOrNull(row.wager);
        const result = row.result == null ? null : (int(row.result) > 0 ? 1 : -1);
        await conn.query(
          `INSERT INTO final_results (game_id, team_index, wager, response, result, points) VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE wager = VALUES(wager), response = VALUES(response),
             result = VALUES(result), points = VALUES(points)`,
          [gid, int(row.team), wager, row.response == null ? null : str(row.response, 200), result,
            result == null ? 0 : result * (wager || 0)]);
      }
    }

    // A +/- from the host panel.
    if (rec.adjust) {
      await conn.query('INSERT INTO score_adjustments (game_id, team_index, delta, made_at) VALUES (?, ?, ?, ?)',
        [gid, int(rec.adjust.team), int(rec.adjust.delta), now()]);
    }

    // The end: finished (with the winner) or abandoned. A finished game stays finished.
    if (rec.end === 'finished' || rec.end === 'abandoned') {
      let winner = null;
      if (rec.end === 'finished' && teams.length) {
        const top = Math.max(...teams.map((t) => int(t.score)));
        winner = teams.filter((t) => int(t.score) === top).map((t) => str(t.name, 60)).join(' & ').slice(0, 200);
      }
      await conn.query(
        `UPDATE games SET status = ?, ended_at = ?, winner = ? WHERE id = ? AND status <> 'finished'`,
        [rec.end, now(), winner, gid]);
    }

    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (e2) {}
    throw e;
  } finally {
    conn.release();
  }
}

// Queue a record. Never throws: a database problem is logged and the game carries on.
function record(rec) {
  if (!pool) return;
  chain = chain.then(() => ready).then(() => write(rec))
    .catch((e) => console.warn('Could not save game history:', e.message));
}

module.exports = { init, record };
