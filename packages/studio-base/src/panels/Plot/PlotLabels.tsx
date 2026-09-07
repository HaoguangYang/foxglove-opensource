// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Alert, Button, Menu, MenuItem, useTheme } from "@mui/material";
import { MutableRefObject, useEffect, useMemo, useRef, useState } from "react";

import {
  useTimelineLabelsStore,
  useTimelineLabelSource,
} from "@foxglove/studio-base/components/TimelineLabels";

import { Scale } from "./ChartRenderer";
import { PlotCoordinator } from "./PlotCoordinator";
import { LabelDraft, PlotLabelEditor } from "./PlotLabelEditor";
import { LabelRange, pixelsForRange, rangeFromPixels } from "./labelTime";
import { usePlotLabelSignals } from "./usePlotLabelSignals";

type Props = {
  canvas: HTMLDivElement | ReactNull;
  coordinator?: PlotCoordinator;
  timestampAxis: boolean;
  draggingRef: MutableRefObject<boolean>;
  signalExpressions: string[];
  signalMetadata: { expression: string; timestampMethod: "receiveTime" | "headerStamp" }[];
  originPanelId: string;
  onDownloadCsv: () => void;
};

/** Labels remain absolute source times; only their screen positions follow the worker's chart scale. */
export function PlotLabels({
  canvas,
  coordinator,
  timestampAxis,
  draggingRef,
  signalExpressions,
  signalMetadata,
  originPanelId,
  onDownloadCsv,
}: Props): JSX.Element {
  const theme = useTheme();
  const source = useTimelineLabelSource();
  const getSignalContext = usePlotLabelSignals(source?.id, signalExpressions, signalMetadata);
  const labels = useTimelineLabelsStore((state) => state.labels);
  const error = useTimelineLabelsStore((state) => state.error);
  const addLabel = useTimelineLabelsStore((state) => state.addLabel);
  const updateLabel = useTimelineLabelsStore((state) => state.updateLabel);
  const deleteLabel = useTimelineLabelsStore((state) => state.deleteLabel);
  const [scale, setScale] = useState<Scale>();
  const scaleRef = useRef<Scale>();
  const [selection, setSelection] = useState<LabelRange & { sourceId: string }>();
  const [editor, setEditor] = useState<{ draft: LabelDraft; sourceId: string }>();
  const [menu, setMenu] = useState<{ left: number; top: number }>();
  const visibleSelection = selection?.sourceId === source?.id ? selection : undefined;
  const visibleEditor = editor?.sourceId === source?.id ? editor : undefined;
  const sourceLabels = useMemo(
    () => labels.filter((label) => label.source.id === source?.id),
    [labels, source?.id],
  );

  useEffect(() => {
    const update = (value: Scale | undefined) => {
      scaleRef.current = value;
      setScale(value);
    };
    update(coordinator?.getXScale());
    coordinator?.on("xScaleChanged", update);
    return () => {
      coordinator?.off("xScaleChanged", update);
    };
  }, [coordinator]);

  useEffect(() => {
    setSelection(undefined);
    setEditor(undefined);
    setMenu(undefined);
  }, [source?.id, timestampAxis]);

  useEffect(() => {
    if (!canvas) {
      return;
    }
    let drag: { pointerId: number; first: number; scale: Scale; moved: boolean } | undefined;
    let resetTimer: ReturnType<typeof setTimeout> | undefined;
    const down = (event: PointerEvent) => {
      if (
        event.button !== 0 ||
        event.pointerType === "touch" ||
        event.shiftKey ||
        !timestampAxis ||
        !source
      ) {
        return;
      }
      const currentScale = scaleRef.current;
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (
        !currentScale ||
        x < currentScale.left ||
        x > currentScale.right ||
        y < currentScale.top ||
        y > currentScale.bottom
      ) {
        return;
      }
      drag = { pointerId: event.pointerId, first: x, scale: currentScale, moved: false };
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId || !source) {
        return;
      }
      const x = event.clientX - canvas.getBoundingClientRect().left;
      if (!drag.moved && Math.abs(x - drag.first) < 5) {
        return;
      }
      drag.moved = true;
      draggingRef.current = true;
      const range = rangeFromPixels(drag.scale, drag.first, x, source.startTime, source.endTime);
      if (range) {
        setSelection({ ...range, sourceId: source.id });
      }
    };
    const up = (event: PointerEvent) => {
      if (drag?.pointerId !== event.pointerId) {
        return;
      }
      move(event);
      drag = undefined;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      // The synthetic click after pointerup must still see a drag and must not seek.
      resetTimer = setTimeout(() => {
        draggingRef.current = false;
      }, 0);
    };
    const cancel = () => {
      drag = undefined;
      draggingRef.current = false;
      setSelection(undefined);
    };
    const lostCapture = () => {
      if (drag) {
        cancel();
      }
    };
    const context = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({ left: event.clientX, top: event.clientY });
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancel();
      }
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("lostpointercapture", lostCapture);
    canvas.addEventListener("contextmenu", context);
    canvas.addEventListener("keydown", key);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", lostCapture);
      canvas.removeEventListener("contextmenu", context);
      canvas.removeEventListener("keydown", key);
      if (drag && canvas.hasPointerCapture(drag.pointerId)) {
        canvas.releasePointerCapture(drag.pointerId);
      }
      clearTimeout(resetTimer);
      draggingRef.current = false;
    };
  }, [canvas, draggingRef, source, timestampAxis]);

  const selectedPixels =
    scale && visibleSelection && source
      ? pixelsForRange(scale, visibleSelection, source.startTime)
      : undefined;
  const visibleLabels =
    timestampAxis && scale && source
      ? sourceLabels.flatMap((label) => {
          const pixels = pixelsForRange(scale, label, source.startTime);
          return pixels ? [{ label, pixels }] : [];
        })
      : [];

  return (
    <>
      {timestampAxis && scale && (
        <>
          {selectedPixels && (
            <div
              data-testid="plot-label-selection"
              style={{
                position: "absolute",
                pointerEvents: "none",
                left: selectedPixels.left,
                width: Math.max(1, selectedPixels.right - selectedPixels.left),
                top: scale.top,
                height: scale.bottom - scale.top,
                backgroundColor: theme.palette.action.selected,
                borderLeft: "2px solid",
                borderRight: "2px solid",
                borderColor: theme.palette.primary.main,
              }}
            />
          )}
          {visibleLabels.map(({ label, pixels }) => (
            <div
              key={label.id}
              style={{
                position: "absolute",
                pointerEvents: "none",
                left: pixels.left,
                width: Math.max(1, pixels.right - pixels.left),
                top: scale.top,
                height: scale.bottom - scale.top,
                backgroundColor: "rgba(255, 180, 0, 0.07)",
                borderLeft: "1px solid",
                borderRight: "1px solid",
                borderColor: theme.palette.warning.main,
              }}
            />
          ))}
          {visibleLabels.length > 0 && (
            <div
              aria-label="Timeline labels"
              tabIndex={0}
              style={{
                position: "absolute",
                // Floating PlotLegend uses 1000. Only the note buttons intercept input here.
                zIndex: 1001,
                top: scale.top + 2,
                left: scale.left,
                width: scale.right - scale.left,
                maxHeight: Math.max(28, (scale.bottom - scale.top) / 2),
                overflowY: "auto",
                overflowX: "hidden",
                pointerEvents: "none",
              }}
            >
              {visibleLabels.map(({ label, pixels }) => (
                <div key={label.id} style={{ height: 28, position: "relative" }}>
                  <Button
                    size="small"
                    variant="contained"
                    color="warning"
                    title={label.title}
                    aria-label={`Edit label: ${label.title}`}
                    onClick={() => {
                      setEditor({ draft: label, sourceId: label.source.id });
                    }}
                    style={{
                      position: "absolute",
                      left: Math.min(
                        pixels.left - scale.left,
                        Math.max(0, scale.right - scale.left - 80),
                      ),
                      maxWidth: Math.min(220, scale.right - scale.left),
                      minWidth: 0,
                      height: 24,
                      pointerEvents: "auto",
                      justifyContent: "flex-start",
                    }}
                  >
                    <span
                      style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {label.title}
                    </span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && !visibleEditor && (
        <Alert severity="error" style={{ position: "absolute", bottom: 0, left: 0 }}>
          {error}
        </Alert>
      )}
      <Menu
        open={menu != undefined}
        onClose={() => {
          setMenu(undefined);
        }}
        anchorReference="anchorPosition"
        anchorPosition={menu}
      >
        <MenuItem
          disabled={!timestampAxis || !source || !visibleSelection}
          onClick={() => {
            setMenu(undefined);
            if (source && visibleSelection) {
              setEditor({
                draft: { ...visibleSelection, title: "", comment: "" },
                sourceId: source.id,
              });
            }
          }}
        >
          {!timestampAxis
            ? "Add label (requires timestamp axis)"
            : !source
            ? "Add label (open a recording first)"
            : !visibleSelection
            ? "Add label (drag to select a time region)"
            : "Add label"}
        </MenuItem>
        <MenuItem
          onClick={() => {
            setMenu(undefined);
            onDownloadCsv();
          }}
        >
          Download plot data as CSV
        </MenuItem>
      </Menu>
      {visibleEditor && source && (
        <PlotLabelEditor
          key={visibleEditor.draft.id ?? "new"}
          draft={visibleEditor.draft}
          error={error}
          onClose={() => {
            setEditor(undefined);
          }}
          onSave={(draft) => {
            const signalContext = getSignalContext();
            const saved = draft.id
              ? updateLabel(draft.id, {
                  title: draft.title,
                  comment: draft.comment,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  ...signalContext,
                })
              : addLabel({
                  title: draft.title,
                  comment: draft.comment,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  source,
                  ...signalContext,
                  originPanelId,
                });
            if (saved != undefined && saved !== false) {
              setEditor(undefined);
              setSelection(undefined);
            }
          }}
          onDelete={() => {
            if (visibleEditor.draft.id && deleteLabel(visibleEditor.draft.id)) {
              setEditor(undefined);
            }
          }}
        />
      )}
    </>
  );
}
