/**
 * True when an agent deliberately addressed the human.
 *
 * `to: ['human']` is the durable form. Early Studio turns instead broadcast a
 * message whose first word was `Human:`; keep that narrow compatibility case
 * so the existing conversation becomes readable immediately. A casual mention
 * of the word "human" elsewhere is not addressing and must not be highlighted.
 */
export function isHumanDirected(message) {
  if (!message || message.from === 'human') return false;
  if (Array.isArray(message.to) && message.to.includes('human')) return true;
  return !message.to?.length && /^\s*human\s*:/i.test(String(message.text ?? ''));
}
