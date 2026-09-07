// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { v4 as uuidv4 } from "uuid";
import { StoreApi, createStore, useStore } from "zustand";

import { NewTimelineLabel, TimelineLabel, TimelineLabelPatch, validLabel } from "./types";

export const LABEL_STORAGE_KEY = "foxglove.timeline-labels.v1";
type LabelStorage = Pick<Storage, "setItem"> & {
  getItem: (key: string) => ReturnType<Storage["getItem"]> | undefined;
};

export type TimelineLabelsState = {
  labels: readonly TimelineLabel[];
  error: string | undefined;
  addLabel: (input: NewTimelineLabel) => TimelineLabel | undefined;
  updateLabel: (id: string, patch: TimelineLabelPatch) => boolean;
  deleteLabel: (id: string) => boolean;
  refresh: () => boolean;
};

function readLabels(storage: LabelStorage): TimelineLabel[] {
  const raw = storage.getItem(LABEL_STORAGE_KEY);
  if (raw == undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  const envelope = parsed as { version?: unknown; labels?: unknown } | undefined;
  if (
    envelope?.version !== 1 ||
    !Array.isArray(envelope.labels) ||
    !envelope.labels.every(validLabel) ||
    new Set(envelope.labels.map((label) => label.id)).size !== envelope.labels.length
  ) {
    throw new Error(
      "Stored labels are invalid or use an unsupported version; the original data is preserved.",
    );
  }
  return envelope.labels;
}

export function createTimelineLabelsStore(getStorage: () => LabelStorage): StoreApi<TimelineLabelsState> {
  let labels: TimelineLabel[] = [];
  let error: string | undefined;
  try {
    labels = readLabels(getStorage());
  } catch (cause) {
    error = `Cannot load saved labels: ${String(cause)}`;
  }
  return createStore<TimelineLabelsState>()((set) => {
    const persist = (change: (previous: TimelineLabel[]) => TimelineLabel[]): boolean => {
      try {
        const storage = getStorage();
        // Read before writing to retain annotations saved by another tab. Never overwrite bad data.
        const next = change(readLabels(storage));
        if (!next.every(validLabel)) {
          throw new Error(
            "Provide a title, valid time range, and content within the length limits.",
          );
        }
        storage.setItem(LABEL_STORAGE_KEY, JSON.stringify({ version: 1, labels: next })!);
        set({ labels: next, error: undefined });
        return true;
      } catch (cause) {
        set({ error: `Labels were not saved: ${String(cause)}` });
        return false;
      }
    };
    return {
      labels,
      error,
      refresh: () => {
        try {
          set({ labels: readLabels(getStorage()), error: undefined });
          return true;
        } catch (cause) {
          set({ error: `Cannot load saved labels: ${String(cause)}` });
          return false;
        }
      },
      addLabel: (input) => {
        const now = new Date().toISOString();
        const label: TimelineLabel = {
          ...input,
          id: uuidv4(),
          createdAt: now,
          updatedAt: now,
        };
        return persist((previous) => [...previous, label]) ? label : undefined;
      },
      updateLabel: (id, patch) =>
        persist((previous) => {
          if (!previous.some((label) => label.id === id)) {
            throw new Error("This label no longer exists. Reopen the recording to refresh labels.");
          }
          return previous.map((label) =>
            label.id === id ? { ...label, ...patch, updatedAt: new Date().toISOString() } : label,
          );
        }),
      deleteLabel: (id) => persist((previous) => previous.filter((label) => label.id !== id)),
    };
  });
}

let sharedStore: ReturnType<typeof createTimelineLabelsStore> | undefined;

export function getTimelineLabelsStore(): ReturnType<typeof createTimelineLabelsStore> {
  if (!sharedStore) {
    sharedStore = createTimelineLabelsStore(() => window.localStorage);
    window.addEventListener("storage", (event) => {
      if (event.key == undefined || event.key === LABEL_STORAGE_KEY) {
        sharedStore?.getState().refresh();
      }
    });
  }
  return sharedStore;
}

export function useTimelineLabelsStore<T>(selector: (state: TimelineLabelsState) => T): T {
  return useStore(getTimelineLabelsStore(), selector);
}
