export function formatClock(t: number): string {
  const s = ((Math.floor(t) % 86_400) + 86_400) % 86_400;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export function formatHm(t: number): string {
  return formatClock(t).slice(0, 5);
}

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "I tid", "3 min sen" or "1 min tidig", styled by how late. */
export function delayBadge(delay: number): string {
  const minutes = Math.round(Math.abs(delay) / 60);
  if (minutes === 0) return `<span class="delay is-ontime">I tid</span>`;
  return delay > 0
    ? `<span class="delay is-late">${minutes} min sen</span>`
    : `<span class="delay is-early">${minutes} min tidig</span>`;
}
