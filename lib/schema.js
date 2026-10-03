// One reservation per gift (item_id is the primary key), so a gift can only be booked once.
// login_attempts backs a simple per-IP throttle on the invitation code.
const STATEMENTS = [
  `create table if not exists reservations (
    item_id text primary key,
    name text not null check (char_length(name) between 1 and 50),
    reserved_at timestamptz not null default now()
  )`,
  `create table if not exists login_attempts (
    ip text not null,
    attempted_at timestamptz not null default now()
  )`,
  `create index if not exists login_attempts_ip_idx on login_attempts (ip, attempted_at)`
];

let ready;

// Runs once per warm function instance. Every statement is idempotent.
export function ensureSchema(query) {
  ready ||= (async () => {
    for (const statement of STATEMENTS) await query(statement);
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

export function resetSchemaCache() {
  ready = undefined;
}
