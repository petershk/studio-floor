/**
 * True when an agent deliberately addressed the human.
 *
 * `to: ['human']` is the durable form. Agents that were never told `human` is a
 * valid recipient instead broadcast a message whose first word addresses them —
 * `Human: …`, and just as often `Human — …`. Only the colon was recognised, so
 * every em-dash message went unmarked and the human had to find their own
 * answers by eye in a wall of team chatter.
 *
 * A casual mention of the word "human" elsewhere is not addressing and must not
 * be highlighted, so the separator is required: a colon or comma straight after
 * the word, or a dash with space around it. That keeps `human-facing` — no
 * space before the dash — out, which is the compound word this is most likely
 * to meet at the start of a sentence.
 */
const ADDRESSES_HUMAN = /^\s*human\s*(?:[:,]|\s+[—–-])(?:\s|$)/i;

export function isHumanDirected(message) {
  if (!message || message.from === 'human') return false;
  if (Array.isArray(message.to) && message.to.includes('human')) return true;
  return !message.to?.length && ADDRESSES_HUMAN.test(String(message.text ?? ''));
}
