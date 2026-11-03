-- Only ever added to: a migration that has shipped is never edited.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  routed TEXT NOT NULL DEFAULT '[]',
  received_at TEXT NOT NULL,
  UNIQUE (source, key)
);
CREATE INDEX events_received ON events (received_at);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  agent TEXT NOT NULL,
  grp TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT NOT NULL,
  claim TEXT,
  token_hash TEXT,
  last_token_hash TEXT,
  last_result TEXT,
  cancel_at TEXT,
  resume TEXT,
  session TEXT,
  link TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  seen_at TEXT,
  finished_at TEXT,
  summary TEXT,
  error TEXT,
  usage TEXT
);
CREATE INDEX runs_state ON runs (state, agent, id);
CREATE INDEX runs_lane ON runs (rule, lane, state);

CREATE TABLE run_events (
  run_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (run_id, event_id)
);
CREATE INDEX run_events_event ON run_events (event_id);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  recommend INTEGER,
  about TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  fyi INTEGER NOT NULL DEFAULT 0,
  quiet INTEGER NOT NULL DEFAULT 0,
  choice INTEGER,
  answer TEXT,
  by TEXT,
  result TEXT,
  rule TEXT,
  lane TEXT NOT NULL DEFAULT '',
  grp TEXT,
  source TEXT,
  agent TEXT,
  session TEXT,
  run_id INTEGER,
  answer_event INTEGER,
  token TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  closed_at TEXT
);
CREATE INDEX cards_key ON cards (key, state);
CREATE INDEX cards_state ON cards (state, grp);
CREATE INDEX cards_answer_event ON cards (answer_event);

CREATE TABLE deliveries (
  card_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  ref TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  first_try_at TEXT,
  not_before TEXT,
  error TEXT,
  given_up INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (card_id, channel)
);

CREATE TABLE timers (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL,
  lane TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  session TEXT,
  about TEXT NOT NULL,
  at TEXT NOT NULL,
  event_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX timers_due ON timers (event_id, at);
CREATE INDEX timers_event ON timers (event_id);

CREATE TABLE schedules (
  rule TEXT PRIMARY KEY,
  cron TEXT NOT NULL,
  next_at TEXT NOT NULL
);

CREATE TABLE seen (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

CREATE TABLE keys (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, name)
);

