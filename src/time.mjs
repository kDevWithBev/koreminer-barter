const TZ = "America/New_York";

function seconds(parts) {
  return parts.hour * 3600 + parts.minute * 60 + parts.second;
}

export function etParts(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

export function inEtSpan(instant, start, end) {
  const parts = etParts(instant);
  if (!parts) return false;
  const clock = seconds(parts);
  return clock >= seconds(start) && clock <= seconds(end);
}

export const INTENT_OPEN = { hour: 20, minute: 15, second: 0 };
export const INTENT_CLOSE = { hour: 20, minute: 55, second: 0 };
export const CONFIRM_OPEN = { hour: 21, minute: 0, second: 0 };
export const CONFIRM_CLOSE = { hour: 21, minute: 10, second: 0 };

export function intentOpen(instant) {
  return inEtSpan(instant, INTENT_OPEN, INTENT_CLOSE);
}

export function confirmOpen(instant) {
  return inEtSpan(instant, CONFIRM_OPEN, CONFIRM_CLOSE);
}

export function nextCallAt(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (date.getTime() <= start) return new Date(start);
  return new Date(start + 24 * 60 * 60 * 1000);
}

export function callClockLabel(instant) {
  const parts = etParts(instant);
  if (!parts) return "";
  const suffix = parts.hour >= 12 ? "PM" : "AM";
  let hour = parts.hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(parts.minute).padStart(2, "0")} ${suffix} ET`;
}

