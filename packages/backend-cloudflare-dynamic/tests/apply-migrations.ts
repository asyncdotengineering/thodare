// DDL applied to the test D1 database before each suite. Mirrors the
// production DDL in src/d1-storage.ts and src/adapter.ts so tests exercise
// the same schema the adapter creates at runtime.

export function ddlStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      run_id TEXT NOT NULL,
      step_id TEXT,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      organization_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      spec_version INTEGER NOT NULL,
      idempotency_key TEXT,
      input TEXT NOT NULL,
      output TEXT,
      error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failed_at TEXT,
      UNIQUE (organization_id, workflow_name, idempotency_key)
    )`,
    `CREATE TABLE IF NOT EXISTS steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      input TEXT,
      output TEXT,
      error TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failed_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'waiting',
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      expired_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS workflows (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      spec_version INTEGER NOT NULL,
      definition TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, id, version)
    )`,
  ];
}
