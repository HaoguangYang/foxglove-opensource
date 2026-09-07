// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";

import { compare } from "@foxglove/rostime";

import { formatLabelTime, LabelRange, parseLabelTime } from "./labelTime";

export type LabelDraft = LabelRange & { id?: string; title: string; comment: string };

export function PlotLabelEditor({
  draft,
  error,
  onSave,
  onDelete,
  onClose,
}: {
  draft: LabelDraft;
  error?: string;
  onSave: (value: LabelDraft) => void;
  onDelete: () => void;
  onClose: () => void;
}): JSX.Element {
  const [title, setTitle] = useState(draft.title);
  const [comment, setComment] = useState(draft.comment);
  const [startText, setStartText] = useState(formatLabelTime(draft.startTime));
  const [endText, setEndText] = useState(formatLabelTime(draft.endTime));
  const [attempted, setAttempted] = useState(false);
  const startTime = parseLabelTime(startText);
  const endTime = parseLabelTime(endText);
  const validation = !title.trim()
    ? "Enter a title."
    : !startTime || !endTime
    ? "Enter valid UTC dates and times."
    : compare(endTime, startTime) < 0
    ? "End time must be at or after start time."
    : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="plot-label-editor-title"
    >
      <DialogTitle id="plot-label-editor-title">
        {draft.id ? "Edit label" : "Add label"}
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} paddingTop={1}>
          <TextField
            autoFocus
            label="Title"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
            required
          />
          <TextField
            label="Comment"
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
            multiline
            minRows={3}
          />
          <Typography variant="caption">
            Times are UTC (UTC+00:00). Format: YYYY-MM-DD HH:mm:ss.SSS; up to 9 fractional digits
            are preserved.
          </Typography>
          <TextField
            label="Start time (UTC)"
            value={startText}
            onChange={(event) => {
              setStartText(event.target.value);
            }}
          />
          <TextField
            label="End time (UTC)"
            value={endText}
            onChange={(event) => {
              setEndText(event.target.value);
            }}
          />
          {attempted && validation && <Alert severity="error">{validation}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {draft.id && (
          <Button color="error" onClick={onDelete}>
            Delete label
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            setAttempted(true);
            if (!validation && startTime && endTime) {
              onSave({ ...draft, title: title.trim(), comment, startTime, endTime });
            }
          }}
        >
          Save label
        </Button>
      </DialogActions>
    </Dialog>
  );
}
