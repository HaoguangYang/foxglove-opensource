// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time } from "@foxglove/rostime";
import { downloadTextFile } from "@foxglove/studio-base/util/download";

import { LabelSource, TimelineLabel, formatLabelTime, timeNanoseconds } from "./types";

type ExportedTime = Time & { unixNs: string; isoUtc: string };
type ExportedLabel = Omit<TimelineLabel, "source" | "startTime" | "endTime"> & {
  source: Omit<LabelSource, "startTime" | "endTime"> & {
    startTime: ExportedTime;
    endTime: ExportedTime;
  };
  startTime: ExportedTime;
  endTime: ExportedTime;
  relativeStartNs: string;
  relativeEndNs: string;
};
export type LabelsExport = {
  format: "foxglove-timeline-labels";
  version: 1;
  exportedAt: string;
  annotationType: "user-authored-note";
  description: string;
  sourceIdentity: string;
  labels: ExportedLabel[];
};

function exportTime(time: Time): ExportedTime {
  return { ...time, unixNs: timeNanoseconds(time).toString(), isoUtc: formatLabelTime(time) };
}

export function createLabelsExport(labels: readonly TimelineLabel[], now = new Date()): LabelsExport {
  return {
    format: "foxglove-timeline-labels",
    version: 1,
    exportedAt: now.toISOString(),
    annotationType: "user-authored-note",
    description:
      "Human-authored annotations, which may include real-world observations, ground truth, or hypotheses, distinct from onboard measured data.",
    sourceIdentity:
      "Source name, kind, sanitized locator, and recording bounds; not a content checksum.",
    labels: labels.map((label) => ({
      ...label,
      source: {
        ...label.source,
        startTime: exportTime(label.source.startTime),
        endTime: exportTime(label.source.endTime),
      },
      startTime: exportTime(label.startTime),
      endTime: exportTime(label.endTime),
      relativeStartNs: (
        timeNanoseconds(label.startTime) - timeNanoseconds(label.source.startTime)
      ).toString(),
      relativeEndNs: (
        timeNanoseconds(label.endTime) - timeNanoseconds(label.source.startTime)
      ).toString(),
    })),
  };
}

export function downloadLabels(labels: readonly TimelineLabel[]): void {
  const now = new Date();
  downloadTextFile(
    JSON.stringify(createLabelsExport(labels, now), undefined, 2)!,
    `foxglove-labels-${now.toISOString().replace(/[:.]/g, "-")}.json`,
  );
}
