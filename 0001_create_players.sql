CREATE TABLE IF NOT EXISTS players (
  username TEXT PRIMARY KEY,
  save_data TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_best_score ON players(best_score DESC);
