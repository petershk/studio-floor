/**
 * What keeps a debate from becoming the work.
 *
 * Debate is how this team gets to good decisions, and the protocol says so. But
 * two properties of the studio combine into an amplifier that has nothing to do
 * with whether a question is worth answering:
 *
 *   - an agent wakes when something is addressed to it, and every debate event
 *     used to be addressed to everyone who did not write it;
 *   - the brief shows every open debate, every turn, and tells an agent when it
 *     has not stated a position yet.
 *
 * So one position wakes the rest of the team, each reply wakes the rest again,
 * and the brief keeps asking the ones who have not spoken to speak. With three
 * agents that sustains itself indefinitely on delivery rules alone. The topic
 * never had to matter, which is why the debates that run longest tend to be the
 * ones about the team's own conventions: unfalsifiable, unowned, and never
 * finished.
 *
 * Two bounds, both derived from things the protocol already says.
 *
 * `inDebate` is who a further exchange is actually for. Everyone still hears a
 * debate open and hears how it ended — those are the parts the team needs. The
 * argument in between is delivered to the people in it.
 *
 * `atRoundLimit` is where arguing stops being how it gets settled. The
 * escalation rules already name "a team that stays divided after two rounds" as
 * a reason to involve the human, so that is the number: two rounds for the
 * roster that exists, after which a position is refused and the debate has to be
 * closed or escalated. It is a cap on the arguing, not on the disagreement — the
 * disagreement is exactly what the human is being handed.
 */

import { AGENT_IDS } from './roster.mjs';

/** Rounds of argument before a debate has to end in an outcome or a human. */
export const DEBATE_ROUNDS = 2;

/**
 * How many positions that is. Scaled to the roster, because a round means every
 * agent speaking once, and a two-agent studio should not get the same budget as
 * a five-agent one.
 */
export function positionLimit(agents = AGENT_IDS.length) {
  return DEBATE_ROUNDS * Math.max(1, agents);
}

export function atRoundLimit(debate, agents = AGENT_IDS.length) {
  return (debate?.positions?.length || 0) >= positionLimit(agents);
}

/**
 * Whether an agent is in this debate: it opened it, or it has taken a position.
 * Used for inbox routing, so it is deliberately about participation and not
 * about who might find it interesting — everyone is told it opened and told how
 * it ended, and can read the whole thing in the brief either way.
 */
export function inDebate(debate, agentId) {
  if (!debate) return false;
  if (debate.openedBy === agentId) return true;
  return (debate.positions || []).some((p) => p.agent === agentId);
}
