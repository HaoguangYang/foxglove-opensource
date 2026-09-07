// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Alert, Button, MenuItem, Paper, Stack, TextField, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";

import {
  Alignment,
  RecordingEvent,
  Track,
  eventAlignment,
  mediaTimeAt,
  parseAlignmentTime,
} from "./alignment";
import { syncVideo } from "./playback";

export type Clock = {
  utcMs: number;
  isPlaying: boolean;
  speed: number;
  lastSeekTime: number;
  sourceKey: string;
  sourceId: string;
};

type Props = {
  track: Track;
  file?: File;
  clock?: Clock;
  events: readonly RecordingEvent[];
  onAlign: (alignment: Alignment) => void;
  onRemove: () => void;
  onReselect: (file: File) => void;
  onPause: () => void;
};

export function TrackCard({
  track,
  file,
  clock,
  events,
  onAlign,
  onRemove,
  onReselect,
  onPause,
}: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(ReactNull);
  const frameRef = useRef<number>();
  const lastSeekRef = useRef<number>();
  const [url, setUrl] = useState<string>();
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string>();
  const [capture, setCapture] = useState<number>();
  const [wallTime, setWallTime] = useState("");
  const [zone, setZone] = useState("UTC");
  const [eventId, setEventId] = useState("");
  const alignment = track.alignment;
  const sourceMatches = alignment?.sourceKey === clock?.sourceKey;
  const preview = editing || alignment == undefined;

  useEffect(() => {
    setReady(false);
    setError(undefined);
    setCapture(undefined);
    frameRef.current = undefined;
    if (!file) {
      setUrl(undefined);
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    setUrl(nextUrl);
    return () => {
      URL.revokeObjectURL(nextUrl);
    };
  }, [file]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !url || typeof video.requestVideoFrameCallback !== "function") {
      return;
    }
    let callbackId: number;
    const rememberFrame: VideoFrameRequestCallback = (_now, metadata) => {
      frameRef.current = metadata.mediaTime;
      callbackId = video.requestVideoFrameCallback(rememberFrame);
    };
    callbackId = video.requestVideoFrameCallback(rememberFrame);
    return () => {
      video.cancelVideoFrameCallback(callbackId);
    };
  }, [url]);

  useEffect(() => {
    setEventId("");
    setCapture(undefined);
    setEditing(false);
  }, [clock?.sourceId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) {
      return;
    }
    if (preview) {
      setVisible(true);
      return;
    }
    if (!clock || !sourceMatches) {
      video.pause();
      setVisible(false);
      return;
    }
    setVisible(
      syncVideo(video, mediaTimeAt(clock.utcMs, alignment), {
        isPlaying: clock.isPlaying,
        speed: clock.speed,
        forceSeek: lastSeekRef.current !== clock.lastSeekTime,
      }),
    );
    lastSeekRef.current = clock.lastSeekTime;
    // A stalled/buffering master must never leave a video free-running indefinitely.
    const timeout = setTimeout(() => {
      video.pause();
    }, 250);
    return () => {
      clearTimeout(timeout);
    };
  }, [alignment, clock, preview, ready, sourceMatches]);

  useEffect(() => {
    const video = videoRef.current;
    return () => video?.pause();
  }, []);

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.seeking || video.readyState < 2) {
      setError("Wait for the selected frame to finish loading.");
      return;
    }
    video.pause();
    onPause();
    const frame =
      typeof video.requestVideoFrameCallback === "function" ? frameRef.current : video.currentTime;
    if (frame == undefined) {
      setError("Wait for the selected frame to be presented, then align it.");
      return;
    }
    setError(undefined);
    setCapture(frame);
    setWallTime(
      new Date(clock?.utcMs ?? Date.now()).toISOString().replace("T", " ").replace("Z", ""),
    );
    setZone("UTC");
  };

  const saveManual = () => {
    if (capture == undefined || !clock) {
      return;
    }
    try {
      const utcMs = parseAlignmentTime(wallTime, zone);
      onAlign({
        method: "manual",
        mediaSeconds: capture,
        utcMs,
        sourceKey: clock.sourceKey,
        timeZone: zone,
        wallTime,
      });
      setEditing(false);
      setCapture(undefined);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Paper variant="outlined" style={{ padding: 12, minWidth: 0 }}>
      <Stack spacing={1}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="subtitle1" style={{ overflowWrap: "anywhere" }}>
            {track.asset.name}
          </Typography>
          <Button size="small" onClick={onRemove}>
            Remove
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {alignment == undefined
            ? "Unaligned · preview independently"
            : alignment.method === "manual"
            ? "Manual alignment"
            : "Recording start (observed)"}
          {alignment &&
            ` · ${new Date(
              alignment.utcMs,
            ).toISOString()} ↔ video ${alignment.mediaSeconds.toFixed(3)} s`}
        </Typography>
        {!file ? (
          <Alert severity="info">
            Reselect this local file to restore playback. The saved layout keeps its alignment, not
            video bytes.
          </Alert>
        ) : (
          <div style={{ position: "relative", backgroundColor: "#000", aspectRatio: "16 / 9" }}>
            <video
              ref={videoRef}
              src={url}
              muted
              playsInline
              preload="auto"
              controls={preview && capture == undefined}
              aria-label={`Video ${track.asset.name}`}
              style={{ width: "100%", height: "100%", visibility: visible ? "visible" : "hidden" }}
              onLoadedMetadata={() => {
                setReady(true);
              }}
              onSeeking={() => {
                frameRef.current = undefined;
              }}
              onError={() => {
                setError(
                  "The browser cannot decode this video. Check its codec or reselect the file.",
                );
              }}
            />
            {!visible && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "grid",
                  placeItems: "center",
                  color: "#fff",
                  padding: 16,
                }}
              >
                {!ready
                  ? "Loading video…"
                  : !clock
                  ? "Open an MCAP to synchronize"
                  : !sourceMatches
                  ? "Alignment belongs to another recording · align again"
                  : "Outside this video's time range"}
              </div>
            )}
          </div>
        )}
        <Button component="label" size="small">
          {file ? "Replace video (clears alignment if different)" : "Reselect video"}
          <input
            hidden
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.webm"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) {
                onReselect(selected);
              }
              event.target.value = "";
            }}
          />
        </Button>
        {file && (
          <>
            {alignment && (
              <Button
                size="small"
                onClick={() => {
                  videoRef.current?.pause();
                  onPause();
                  setEditing(!editing);
                  setCapture(undefined);
                }}
              >
                {editing
                  ? "Return to synchronized playback"
                  : "Choose a frame for manual alignment"}
              </Button>
            )}
            {preview && (
              <>
                <Typography variant="caption">
                  Use the video controls to choose a frame. This preview is detached from MCAP
                  playback.
                </Typography>
                <Button disabled={!ready || !clock} onClick={captureFrame}>
                  Align this frame with time
                </Button>
              </>
            )}
            {capture != undefined && (
              <>
                <Typography variant="caption">
                  Captured video frame: {capture.toFixed(6)} s. The frame stays fixed for this
                  alignment; video frame timing may be coarser than 1 ms.
                </Typography>
                <Button
                  size="small"
                  onClick={() => {
                    setCapture(undefined);
                  }}
                >
                  Choose another frame
                </Button>
                <TextField
                  label="Date and time (milliseconds)"
                  value={wallTime}
                  placeholder="2026-09-06 14:30:00.123"
                  onChange={(event) => {
                    setWallTime(event.target.value);
                  }}
                  size="small"
                />
                <TextField
                  label="Time zone"
                  value={zone}
                  helperText="UTC, +08:00, or Asia/Shanghai. For a repeated DST hour, enter its explicit UTC offset."
                  onChange={(event) => {
                    setZone(event.target.value);
                  }}
                  size="small"
                />
                <Button onClick={saveManual}>Save manual alignment</Button>
              </>
            )}
            <TextField
              select
              size="small"
              label="Recording start event"
              value={events.some((event) => event.id === eventId) ? eventId : ""}
              onChange={(event) => {
                setEventId(event.target.value);
              }}
              disabled={!clock || events.length === 0}
            >
              {events.map((event) => (
                <MenuItem key={event.id} value={event.id}>
                  {new Date(event.timeMs).toISOString()} · {event.description}
                </MenuItem>
              ))}
            </TextField>
            <Button
              disabled={!ready || !clock || !events.some((event) => event.id === eventId)}
              onClick={() => {
                const event = events.find((item) => item.id === eventId);
                if (event && clock) {
                  onAlign(eventAlignment(event, clock.sourceKey));
                  setEditing(false);
                  setCapture(undefined);
                  setError(undefined);
                }
              }}
            >
              Align clip beginning with recording event
            </Button>
            <Typography variant="caption" color="text.secondary">
              Use a full, untrimmed clip. This aligns video time 0 to the first observed recording
              status, which may follow the first camera exposure.
            </Typography>
          </>
        )}
        {error && (
          <Alert
            severity="error"
            onClose={() => {
              setError(undefined);
            }}
          >
            {error}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}
