// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time } from "@foxglove/rostime";

/** Metadata identity, not a content checksum. No credentials or URL query strings are retained. */
export type LabelSource = {
  id: string;
  name: string;
  kind: string;
  startTime: Time;
  endTime: Time;
  locator?: string;
};

export type TimelineLabel = {
  id: string;
  title: string;
  comment: string;
  startTime: Time;
  endTime: Time;
  source: LabelSource;
  signalExpressions: string[];
  signalMetadata?: { expression: string; timestampMethod: "receiveTime" | "headerStamp" }[];
  createdAt: string;
  updatedAt: string;
  originPanelId?: string;
};

export type NewTimelineLabel = Omit<TimelineLabel, "id" | "createdAt" | "updatedAt">;
export type TimelineLabelPatch = Partial<
  Pick<
    TimelineLabel,
    "title" | "comment" | "startTime" | "endTime" | "signalExpressions" | "signalMetadata"
  >
>;

export const MAX_LABEL_TITLE_LENGTH = 200;
export const MAX_LABEL_COMMENT_LENGTH = 20000;

export function validTime(value: unknown): value is Time {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const time = value as Time;
  return (
    Number.isSafeInteger(time.sec) &&
    time.sec >= 0 &&
    time.sec <= 253402300799 &&
    Number.isInteger(time.nsec) &&
    time.nsec >= 0 &&
    time.nsec < 1e9
  );
}

export function timeNanoseconds(time: Time): bigint {
  return BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
}

export function formatLabelTime(time: Time): string {
  return `${new Date(time.sec * 1000).toISOString().slice(0, 19)}.${String(time.nsec).padStart(
    9,
    "0",
  )}Z`;
}

/** UTC editor accepts one through nine fractional digits without rounding through Date. */
export function parseLabelTime(text: string): Time {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(text);
  if (!match) {
    throw new Error("Enter UTC time as YYYY-MM-DDTHH:mm:ss.fffffffffZ.");
  }
  const millis = Date.parse(`${match[1]}.000Z`);
  const result = { sec: millis / 1000, nsec: Number((match[2] ?? "").padEnd(9, "0")) };
  if (!validTime(result) || new Date(millis).toISOString().slice(0, 19) !== match[1]) {
    throw new Error("Enter a valid UTC date and time.");
  }
  return result;
}

function isString(value: unknown, max = 20000): value is string {
  return typeof value === "string" && value.length <= max;
}

export function validLabel(value: unknown): value is TimelineLabel {
  if (typeof value !== "object" || value == undefined) {
    return false;
  }
  const label = value as TimelineLabel;
  const source = label.source;
  return (
    isString(label.id, 200) &&
    label.id.length > 0 &&
    isString(label.title, MAX_LABEL_TITLE_LENGTH) &&
    label.title.trim().length > 0 &&
    isString(label.comment, MAX_LABEL_COMMENT_LENGTH) &&
    validTime(label.startTime) &&
    validTime(label.endTime) &&
    timeNanoseconds(label.endTime) >= timeNanoseconds(label.startTime) &&
    typeof source === "object" &&
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime validation of untrusted JSON.
    source != undefined &&
    isString(source.id) &&
    source.id.length > 0 &&
    isString(source.name) &&
    isString(source.kind, 200) &&
    (source.locator == undefined || isString(source.locator)) &&
    validTime(source.startTime) &&
    validTime(source.endTime) &&
    timeNanoseconds(source.endTime) >= timeNanoseconds(source.startTime) &&
    Array.isArray(label.signalExpressions) &&
    label.signalExpressions.length <= 1000 &&
    label.signalExpressions.every((expression) => isString(expression)) &&
    (label.signalMetadata == undefined ||
      (Array.isArray(label.signalMetadata) &&
        label.signalMetadata.length <= 1000 &&
        label.signalMetadata.every(
          (signal) =>
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime validation of untrusted JSON.
            signal != undefined &&
            isString(signal.expression) &&
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Runtime validation of untrusted JSON.
            (signal.timestampMethod === "receiveTime" || signal.timestampMethod === "headerStamp"),
        ))) &&
    isString(label.createdAt, 30) &&
    Number.isFinite(Date.parse(label.createdAt)) &&
    isString(label.updatedAt, 30) &&
    Number.isFinite(Date.parse(label.updatedAt)) &&
    (label.originPanelId == undefined || isString(label.originPanelId, 200))
  );
}
