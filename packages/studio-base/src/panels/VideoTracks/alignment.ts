// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import moment from "moment-timezone";

export type AssetIdentity = { name: string; size: number; lastModified: number };
export type RecordingEvent = {
  id: string;
  timeMs: number;
  topic: string;
  description: string;
  previousObservedUtcMs?: number;
  observationIntervalMs?: number;
  timeBasis?: "camera_status_observation";
};
export type Alignment = {
  method: "manual" | "recording-event";
  utcMs: number;
  mediaSeconds: number;
  sourceKey: string;
  timeZone?: string;
  wallTime?: string;
  event?: RecordingEvent;
};
export type Track = { id: string; asset: AssetIdentity; alignment?: Alignment };
export type Config = { tracks: Track[] };

export function matchesAsset(a: AssetIdentity, b: AssetIdentity): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

/** Resolve wall time independently of the browser zone; require an offset for DST overlaps. */
export function parseAlignmentTime(wallTime: string, timeZone: string): number {
  const normalized = wallTime.trim().replace("T", " ");
  const format = "YYYY-MM-DD HH:mm:ss.SSS";
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(normalized)) {
    throw new Error("Enter a complete date and time: YYYY-MM-DD HH:mm:ss.SSS");
  }
  const wall = moment.utc(normalized, format, true);
  if (!wall.isValid()) {
    throw new Error("Invalid calendar date or time.");
  }
  const zoneName = timeZone.trim();
  if (zoneName === "UTC" || zoneName === "Z") {
    return wall.valueOf();
  }
  const fixed = /^(?:UTC)?([+-])(\d{2}):(\d{2})$/.exec(zoneName);
  if (fixed) {
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3]);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
      throw new Error("UTC offset must be between -14:00 and +14:00.");
    }
    return wall.valueOf() - (fixed[1] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000;
  }
  const zone = moment.tz.zone(zoneName);
  if (!zone) {
    throw new Error("Unknown time zone. Use UTC, +08:00, or an IANA zone such as Asia/Shanghai.");
  }
  const candidates = [...new Set(zone.offsets)]
    .map((offset) => wall.valueOf() + offset * 60_000)
    .filter((utcMs) => moment.tz(utcMs, zoneName).format(format) === normalized);
  if (candidates.length === 0) {
    throw new Error(
      "This local time does not exist because the clock moves forward. Choose another time.",
    );
  }
  if (candidates.length !== 1) {
    throw new Error(
      "This local time occurs twice. Specify a fixed UTC offset (for example -04:00 or -05:00).",
    );
  }
  return candidates[0]!;
}

export function mediaTimeAt(utcMs: number, alignment: Alignment): number {
  return alignment.mediaSeconds + (utcMs - alignment.utcMs) / 1000;
}

export function eventAlignment(event: RecordingEvent, sourceKey: string): Alignment {
  return { method: "recording-event", utcMs: event.timeMs, mediaSeconds: 0, sourceKey, event };
}

export function inVideoRange(seconds: number, duration: number): boolean {
  return (
    Number.isFinite(seconds) && Number.isFinite(duration) && seconds >= 0 && seconds < duration
  );
}
