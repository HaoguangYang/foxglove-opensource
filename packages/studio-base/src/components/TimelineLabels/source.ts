// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useMemo } from "react";

import { Time } from "@foxglove/rostime";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";

import { LabelSource, validTime } from "./types";

/** Player names can themselves be URLs. Strip authentication and signed query parameters. */
export function sanitizedLocator(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return url.protocol;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function createSourceDescriptor(
  player: {
    name?: string;
    urlState?: { sourceId: string; parameters?: Readonly<Record<string, string>> };
    activeData?: { startTime: Time; endTime: Time };
  },
): LabelSource | undefined {
  const active = player.activeData;
  if (!active || !player.name || !validTime(active.startTime) || !validTime(active.endTime)) {
    return undefined;
  }
  const name = sanitizedLocator(player.name);
  const kind = player.urlState?.sourceId ?? "recording";
  const rawLocator = player.urlState?.parameters?.url;
  const locator = rawLocator == undefined ? undefined : sanitizedLocator(rawLocator);
  const startTime = { ...active.startTime };
  const endTime = { ...active.endTime };
  return {
    id: JSON.stringify([kind, name, locator, startTime, endTime])!,
    name,
    kind,
    locator,
    startTime,
    endTime,
  };
}

const selectPlayer = (context: MessagePipelineContext) => context.playerState;

export function useTimelineLabelSource(): LabelSource | undefined {
  const player = useMessagePipeline(selectPlayer);
  // Retain object identity during playback ticks; only metadata, not the player UUID, scopes labels.
  const descriptor = createSourceDescriptor(player);
  const key = descriptor?.id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => descriptor, [key]);
}
