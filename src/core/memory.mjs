/**
 * The team's durable working set.
 *
 * Every other kind of record in this log says that something happened. Memory is
 * the opposite: a small, editable set of facts the team wants handed back to it
 * on every future turn — the conventions of this repo, the command that has to be
 * run from the root, the thing that was tried and did not work, how the human
 * likes to be told about progress.
 *
 * It exists because nothing else here survives a lost session. Each agent's
 * recollection of its own past turns lives inside its vendor's session, which is
 * compacted, expired and occasionally lost outright; when that happens the agent
 * comes back knowing only what the brief tells it. Decisions and discoveries are
 * the closest existing thing, and they are the wrong shape: a decision is
 * immutable by design, and a discovery is an observation, not something anyone
 * curates. Memory is small, revisable, and always injected.
 *
 * Three scopes:
 *
 *   team    what the whole team should know. The default, because the failure
 *           this feature exists to prevent is four agents learning the same
 *           lesson separately.
 *   self    one agent's own working notes. Still in the shared log — nothing
 *           here is private from the human — but injected only into that
 *           agent's brief, so a note about how *you* work does not cost the
 *           others prompt space.
 *   human   how the human works: what they want to be asked about, how they
 *           want progress reported, what they have said they dislike.
 *
 * It is bounded, and the bound is deliberately small. This is injected into every
 * turn of every agent, so an unbounded memory is an unbounded per-turn bill and,
 * eventually, the truncation of the brief around it. When a scope is full the
 * write is refused and the agent is told what it could forget — the studio does
 * not evict the oldest entry on the agent's behalf, because "which of these no
 * longer matters" is a judgement, and silently making it is how a team loses the
 * one line it needed.
 */

export const MEMORY_SCOPES = ['team', 'self', 'human'];

/**
 * Characters, not tokens — a character count means the same thing to every
 * provider on the roster, and this file must not care which vendor is reading.
 */
export const MEMORY_LIMITS = {
  entry: 400,     // one entry
  scope: 4000,    // one scope's total (`self` is budgeted per agent)
  entries: 24,    // one scope's count, so no scope becomes a list to skim
};

/** Every entry still standing, oldest first. */
export function activeMemory(state) {
  return (state?.memory || []).filter((m) => !m.forgotten);
}

/**
 * What one agent is handed. The shared scopes plus its own notes — another
 * agent's `self` entries are visible to the human in the log and in the UI, but
 * they are not spent on this agent's prompt.
 */
export function memoryFor(state, agentId) {
  return activeMemory(state).filter((m) => m.scope !== 'self' || m.owner === agentId);
}

/**
 * The entries competing for one budget. `self` is budgeted per agent rather than
 * globally: one agent filling its own notebook must not stop another writing to
 * theirs.
 */
export function scopeEntries(state, scope, owner = null) {
  return activeMemory(state).filter(
    (m) => m.scope === scope && (scope !== 'self' || m.owner === owner),
  );
}

export function scopeChars(entries) {
  return entries.reduce((n, m) => n + (m.text?.length || 0), 0);
}
