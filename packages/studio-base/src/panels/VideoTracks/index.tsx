// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Alert, Button, Stack, Typography } from "@mui/material";
import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Panel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

import { Clock, TrackCard } from "./TrackCard";
import { Config, Track, matchesAsset } from "./alignment";
import { CAMERA_STATUS_TOPIC, RecordingEventStore } from "./recordingEvents";

const selectPlayer = (ctx: MessagePipelineContext) => ctx.playerState;
const selectSetSubscriptions = (ctx: MessagePipelineContext) => ctx.setSubscriptions;
const selectPause = (ctx: MessagePipelineContext) => ctx.pausePlayback;

export function VideoTracks({
  config,
  saveConfig,
}: {
  config: Config;
  saveConfig: SaveConfig<Config>;
}): JSX.Element {
  const player = useMessagePipeline(selectPlayer);
  const setSubscriptions = useMessagePipeline(selectSetSubscriptions);
  const pause = useMessagePipeline(selectPause);
  const [subscriberId] = useState(uuidv4);
  const [files, setFiles] = useState<Record<string, File>>({});
  const eventStore = useRef(new RecordingEventStore());
  const tracks = config.tracks;
  const active = player.activeData;
  const hasEvents = active?.topics.some((topic) => topic.name === CAMERA_STATUS_TOPIC) === true;

  useEffect(() => {
    setSubscriptions(
      subscriberId,
      hasEvents ? [{ topic: CAMERA_STATUS_TOPIC, preloadType: "full" }] : [],
    );
    return () => {
      setSubscriptions(subscriberId, []);
    };
  }, [hasEvents, setSubscriptions, subscriberId]);

  const blocks = player.progress.messageCache?.blocks;
  const cachedMessages = useMemo(
    () => blocks?.flatMap((block) => block?.messagesByTopic[CAMERA_STATUS_TOPIC] ?? []) ?? [],
    [blocks],
  );
  const events = useMemo(
    () =>
      eventStore.current.update(player.playerId, [
        ...cachedMessages,
        ...(active?.messages.filter((event) => event.topic === CAMERA_STATUS_TOPIC) ?? []),
      ]),
    [active?.messages, cachedMessages, player.playerId],
  );

  const clock = useMemo<Clock | undefined>(
    () =>
      active
        ? {
            utcMs: active.currentTime.sec * 1000 + active.currentTime.nsec / 1e6,
            isPlaying: active.isPlaying,
            speed: active.speed,
            lastSeekTime: active.lastSeekTime,
            // A stable source descriptor permits reselecting the same recording after layout reload.
            sourceKey: JSON.stringify([player.name, active.startTime, active.endTime])!,
            sourceId: player.playerId,
          }
        : undefined,
    [active, player.name, player.playerId],
  );

  const importFiles = (selected: FileList) => {
    const nextFiles = { ...files };
    const nextTracks = [...tracks];
    for (const file of Array.from(selected)) {
      const missing = nextTracks.find(
        (track) => nextFiles[track.id] == undefined && matchesAsset(track.asset, file),
      );
      const id = missing?.id ?? uuidv4();
      if (!missing) {
        nextTracks.push({
          id,
          asset: { name: file.name, size: file.size, lastModified: file.lastModified },
        });
      }
      nextFiles[id] = file;
    }
    setFiles(nextFiles);
    saveConfig({ tracks: nextTracks });
  };
  const updateTrack = (id: string, change: Partial<Track>) => {
    saveConfig((previous) => ({
      tracks: previous.tracks.map((track) => (track.id === id ? { ...track, ...change } : track)),
    }));
  };

  return (
    <Stack style={{ height: "100%", overflow: "hidden" }}>
      <PanelToolbar />
      <Stack spacing={1.5} style={{ padding: 12, overflow: "auto" }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Typography variant="body2">
            Import videos, align each track, then use the main MCAP playback controls.
          </Typography>
          <Button variant="contained" component="label" style={{ flexShrink: 0 }}>
            Import videos
            <input
              hidden
              type="file"
              multiple
              accept="video/*,.mp4,.mov,.mkv,.webm"
              onChange={(event) => {
                if (event.target.files) {
                  importFiles(event.target.files);
                }
                event.target.value = "";
              }}
            />
          </Button>
        </Stack>
        {!active && (
          <Alert severity="info">
            Open the main MCAP to enable alignment and synchronized playback.
          </Alert>
        )}
        {active && !hasEvents && (
          <Alert severity="info">
            Camera recording status ({CAMERA_STATUS_TOPIC}) is unavailable in this MCAP. Use manual
            alignment, or include this existing DDS topic when converting the sortie.
          </Alert>
        )}
        {hasEvents && (
          <Typography variant="caption" color="text.secondary">
            {events.length} recording start events loaded. The event list loads across the recording
            independently of the playhead; additional events may appear while loading.
          </Typography>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 12,
          }}
        >
          {tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              file={files[track.id]}
              clock={clock}
              events={events}
              onPause={() => pause?.()}
              onAlign={(alignment) => {
                updateTrack(track.id, { alignment });
              }}
              onRemove={() => {
                setFiles((previous) => {
                  const next = { ...previous };
                  delete next[track.id];
                  return next;
                });
                saveConfig((previous) => ({
                  tracks: previous.tracks.filter((item) => item.id !== track.id),
                }));
              }}
              onReselect={(file) => {
                setFiles((previous) => ({ ...previous, [track.id]: file }));
                updateTrack(track.id, {
                  asset: { name: file.name, size: file.size, lastModified: file.lastModified },
                  alignment: matchesAsset(track.asset, file) ? track.alignment : undefined,
                });
              }}
            />
          ))}
        </div>
        {tracks.length === 0 && (
          <Typography color="text.secondary">
            Video files remain on this computer. Reloading the layout requires reselecting the same
            files.
          </Typography>
        )}
      </Stack>
    </Stack>
  );
}

VideoTracks.panelType = "VideoTracks";
VideoTracks.defaultConfig = { tracks: [] } as Config;

export default Panel(VideoTracks);
