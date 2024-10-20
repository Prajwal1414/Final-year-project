CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  image TEXT,
  generations INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS virtualbox (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  visibility TEXT,
  user_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS users_to_virtualboxes (
  userId TEXT NOT NULL,
  virtualboxId TEXT NOT NULL,
  sharedOn INTEGER,
  PRIMARY KEY (userId, virtualboxId),
  FOREIGN KEY (userId) REFERENCES user(id),
  FOREIGN KEY (virtualboxId) REFERENCES virtualbox(id)
);