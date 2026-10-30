import { existsSync } from "node:fs";
import { join } from "node:path";
import { readCsv } from "./csv.js";

const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
] as const;

/** "25:10:00" -> 90600. GTFS times go past 24:00 for trips that run after midnight. */
export function parseGtfsTime(value: string): number {
  const [h = 0, m = 0, s = 0] = value.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/** Service date (YYYYMMDD) and seconds since midnight, in Stockholm local time. */
export function stockholmTime(date: Date): { serviceDate: string; seconds: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Stockholm",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    serviceDate: `${parts.year}${parts.month}${parts.day}`,
    seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

function toUtcDate(serviceDate: string): Date {
  return new Date(Date.UTC(
    Number(serviceDate.slice(0, 4)),
    Number(serviceDate.slice(4, 6)) - 1,
    Number(serviceDate.slice(6, 8)),
  ));
}

export function previousServiceDate(serviceDate: string): string {
  const d = toUtcDate(serviceDate);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/** service_ids that run on the given date, from calendar.txt and calendar_dates.txt. */
export async function activeServiceIds(dir: string, serviceDate: string): Promise<Set<string>> {
  const weekday = WEEKDAYS[toUtcDate(serviceDate).getUTCDay()]!;
  const active = new Set<string>();

  const calendarPath = join(dir, "calendar.txt");
  if (existsSync(calendarPath)) {
    for await (const row of readCsv(calendarPath)) {
      const inRange = row.start_date! <= serviceDate && serviceDate <= row.end_date!;
      if (inRange && row[weekday] === "1") active.add(row.service_id!);
    }
  }

  const datesPath = join(dir, "calendar_dates.txt");
  if (existsSync(datesPath)) {
    for await (const row of readCsv(datesPath)) {
      if (row.date !== serviceDate) continue;
      if (row.exception_type === "1") active.add(row.service_id!);
      if (row.exception_type === "2") active.delete(row.service_id!);
    }
  }

  return active;
}
