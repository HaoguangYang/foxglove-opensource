// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { add, fromSec, subtract, toSec } from "@foxglove/rostime";
import { Time } from "@foxglove/studio";

import { Scale } from "./ChartRenderer";

export type LabelRange = { startTime: Time; endTime: Time };

export function rangeFromPixels(
  scale: Scale,
  first: number,
  last: number,
  startTime: Time,
  endTime: Time,
): LabelRange | undefined {
  if (scale.right <= scale.left || scale.max <= scale.min) {
    return undefined;
  }
  const duration = toSec(subtract(endTime, startTime));
  const time = (pixel: number) => {
    const x = Math.max(scale.left, Math.min(scale.right, pixel));
    const offset =
      scale.min + ((x - scale.left) / (scale.right - scale.left)) * (scale.max - scale.min);
    return add(startTime, fromSec(Math.max(0, Math.min(duration, offset))));
  };
  return { startTime: time(Math.min(first, last)), endTime: time(Math.max(first, last)) };
}

export function pixelsForRange(
  scale: Scale,
  range: LabelRange,
  sourceStart: Time,
): { left: number; right: number } | undefined {
  const start = toSec(subtract(range.startTime, sourceStart));
  const end = toSec(subtract(range.endTime, sourceStart));
  if (scale.max <= scale.min || end < scale.min || start > scale.max) {
    return undefined;
  }
  const pixel = (value: number) =>
    scale.left +
    ((Math.max(scale.min, Math.min(scale.max, value)) - scale.min) / (scale.max - scale.min)) *
      (scale.right - scale.left);
  return { left: pixel(start), right: pixel(end) };
}

export function formatLabelTime(time: Time): string {
  return `${new Date(time.sec * 1000).toISOString().slice(0, 19).replace("T", " ")}.${String(
    time.nsec,
  ).padStart(9, "0")}`;
}

/** UTC input with explicit precision; invalid calendar dates must not silently roll over. */
export function parseLabelTime(value: string): Time | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const iso = `${match[1]}T${match[2]}`;
  const ms = Date.parse(`${iso}.000Z`);
  if (!Number.isFinite(ms) || ms < 0 || new Date(ms).toISOString().slice(0, 19) !== iso) {
    return undefined;
  }
  return { sec: ms / 1000, nsec: Number((match[3] ?? "").padEnd(9, "0")) };
}
