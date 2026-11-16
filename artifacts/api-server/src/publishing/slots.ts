export const PRESETS = [
  { provider: "youtube", platform: "YouTube Shorts", slots: ["12:30", "16:30", "20:30"] },
  { provider: "tiktok", platform: "TikTok", slots: ["11:30", "15:00", "19:00", "22:00"] },
  { provider: "instagram", platform: "Instagram Reels", slots: ["10:00", "19:30"] },
  { provider: "x", platform: "X", slots: ["09:00", "13:00", "17:30", "21:00"] },
];
export function validTimezone(timezone: string) {
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(timezone)) return false;
  try { return !!new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone; } catch { return false; }
}
/** Iterate real UTC minutes: nonexistent local DST times are skipped; repeated slots use first occurrence only. */
export function nextSlot(after: Date, timezone: string, slots: string[], occupied: Set<string>) {
  if (!validTimezone(timezone) || !slots.length || slots.some((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))) throw new Error("Invalid schedule timezone or slots.");
  const format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (date: Date) => {
    const p = Object.fromEntries(format.formatToParts(date).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  };
  // Include preceding minutes in the duplicate set to avoid the second occurrence of a fall-back slot.
  const seen = new Set<string>();
  const floor = Math.floor(after.getTime() / 60000) * 60000;
  for (let ms = floor - 3 * 3600000; ms <= floor + 370 * 86400000; ms += 60000) {
    const date = new Date(ms), value = local(date), key = `${value.day} ${value.time}`;
    if (!slots.includes(value.time) || seen.has(key)) continue;
    seen.add(key);
    if (ms > after.getTime() && !occupied.has(date.toISOString())) return date;
  }
  throw new Error("No available schedule slot in the next year.");
}
