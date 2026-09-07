/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, fireEvent, render, screen } from "@testing-library/react";
import EventEmitter from "eventemitter3";

import {
  useTimelineLabelsStore,
  useTimelineLabelSource,
} from "@foxglove/studio-base/components/TimelineLabels";
import { createLabelsExport } from "@foxglove/studio-base/components/TimelineLabels/export";
import {
  createTimelineLabelsStore,
  TimelineLabelsState,
} from "@foxglove/studio-base/components/TimelineLabels/store";

import { PlotCoordinator } from "./PlotCoordinator";
import { PlotLabels } from "./PlotLabels";

jest.mock("@foxglove/studio-base/components/TimelineLabels", () => ({
  useTimelineLabelsStore: jest.fn(),
  useTimelineLabelSource: jest.fn(),
}));

const source = {
  id: "recording-one",
  name: "one.mcap",
  kind: "file",
  startTime: { sec: 1700000000, nsec: 123456789 },
  endTime: { sec: 1700000020, nsec: 123456789 },
};
const scale = { min: 0, max: 20, left: 50, right: 550, top: 10, bottom: 250 };
const label = {
  id: "one",
  title:
    "A long note title that must visually truncate while preserving its complete exported content",
  comment: "Ground truth",
  startTime: { sec: 1700000004, nsec: 123456789 },
  endTime: { sec: 1700000008, nsec: 123456789 },
  source,
  signalExpressions: ["/signal.value"],
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
};

function persistedLabelsFixture() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? ReactNull,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const store = createTimelineLabelsStore(() => storage);
  store
    .getState()
    .addLabel({
      ...label,
      signalMetadata: [{ expression: "/signal.value", timestampMethod: "headerStamp" }],
    });
  jest.mocked(useTimelineLabelsStore).mockImplementation((selector) => selector(store.getState()));
  const exportedLabels = () =>
    createLabelsExport(createTimelineLabelsStore(() => storage).getState().labels).labels;
  return { data, exportedLabels };
}
let state: TimelineLabelsState;

beforeEach(() => {
  state = {
    labels: [],
    error: undefined,
    addLabel: jest.fn().mockReturnValue(label),
    updateLabel: jest.fn().mockReturnValue(true),
    deleteLabel: jest.fn().mockReturnValue(true),
    refresh: jest.fn(),
  };
  jest.mocked(useTimelineLabelSource).mockReturnValue(source);
  jest.mocked(useTimelineLabelsStore).mockImplementation((selector) => selector(state));
});

it.each([
  {
    name: "newly visible paths and their current timestamp conventions",
    expressions: ["/camera.recording", "/imu.accel.x"],
    metadata: [
      { expression: "/camera.recording", timestampMethod: "receiveTime" as const },
      { expression: "/imu.accel.x", timestampMethod: "headerStamp" as const },
    ],
  },
  { name: "no visible paths", expressions: [], metadata: [] },
])("exports label edits with $name at save time", ({ expressions, metadata }) => {
  const persisted = persistedLabelsFixture();
  const view = fixture();
  fireEvent.click(screen.getByRole("button", { name: `Edit label: ${label.title}` }));
  // Visibility changes after opening the editor, so an open-time snapshot is stale.
  view.rerender(
    <PlotLabels {...view.props} signalExpressions={expressions} signalMetadata={metadata} />,
  );
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Updated evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  const exported = persisted.exportedLabels();
  expect(exported).toHaveLength(1);
  expect(exported[0]).toMatchObject({
    comment: "Updated evidence",
    signalExpressions: expressions,
    signalMetadata: metadata,
  });
  view.cleanup();
});

it("keeps persisted signal provenance unchanged when editing is canceled after visibility changes", () => {
  const persisted = persistedLabelsFixture();
  const originalStorage = [...persisted.data];
  const view = fixture();
  fireEvent.click(screen.getByRole("button", { name: `Edit label: ${label.title}` }));
  view.rerender(<PlotLabels {...view.props} signalExpressions={[]} signalMetadata={[]} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Unsaved evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect([...persisted.data]).toEqual(originalStorage);
  expect(persisted.exportedLabels()[0]).toMatchObject({
    comment: "Ground truth",
    signalExpressions: ["/signal.value"],
    signalMetadata: [{ expression: "/signal.value", timestampMethod: "headerStamp" }],
  });
  view.cleanup();
});

function fixture({ timestampAxis = true } = {}) {
  const canvas = document.createElement("div");
  document.body.appendChild(canvas);
  canvas.setPointerCapture = jest.fn();
  canvas.releasePointerCapture = jest.fn();
  canvas.hasPointerCapture = jest.fn().mockReturnValue(true);
  const coordinator = Object.assign(new EventEmitter(), {
    getXScale: () => scale,
  }) as unknown as PlotCoordinator;
  const props = {
    canvas,
    coordinator,
    timestampAxis,
    draggingRef: { current: false },
    signalExpressions: ["/signal.value"],
    signalMetadata: [{ expression: "/signal.value", timestampMethod: "headerStamp" as const }],
    originPanelId: "plot-one",
    onDownloadCsv: jest.fn(),
  };
  const rendered = render(<PlotLabels {...props} />);
  return {
    ...rendered,
    props,
    cleanup: () => {
      rendered.unmount();
      canvas.remove();
    },
  };
}

function pointer(
  canvas: HTMLElement,
  type: string,
  x: number,
  extra: Record<string, unknown> = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: 80,
    ...extra,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(canvas, event);
}

it("creates a reversed drag range with source and signal timestamp provenance; retains CSV", () => {
  const view = fixture();
  pointer(view.props.canvas, "pointerdown", 250);
  pointer(view.props.canvas, "pointermove", 150);
  pointer(view.props.canvas, "pointerup", 150);
  expect(view.props.draggingRef.current).toBe(true);
  expect(screen.getByTestId("plot-label-selection")).toBeDefined();
  fireEvent.contextMenu(view.props.canvas, { clientX: 160, clientY: 80 });
  expect(screen.getByRole("menuitem", { name: "Download plot data as CSV" })).toBeDefined();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add label" }));
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Failure onset" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(state.addLabel).toHaveBeenCalledWith(
    expect.objectContaining({
      startTime: label.startTime,
      endTime: label.endTime,
      title: "Failure onset",
      source,
      signalExpressions: ["/signal.value"],
      signalMetadata: view.props.signalMetadata,
    }),
  );
  expect(screen.queryByTestId("plot-label-selection")).toBeNull();
  view.cleanup();
});

it("keeps click-to-seek available below threshold and preserves Shift-drag panning", () => {
  const view = fixture();
  pointer(view.props.canvas, "pointerdown", 150);
  pointer(view.props.canvas, "pointerup", 152);
  expect(view.props.draggingRef.current).toBe(false);
  expect(screen.queryByTestId("plot-label-selection")).toBeNull();
  pointer(view.props.canvas, "pointerdown", 150, { shiftKey: true });
  pointer(view.props.canvas, "pointermove", 350, { shiftKey: true });
  expect(screen.queryByTestId("plot-label-selection")).toBeNull();
  view.cleanup();
});

it("disables labeling on custom axes while retaining the CSV action", () => {
  const view = fixture({ timestampAxis: false });
  fireEvent.contextMenu(view.props.canvas);
  expect(
    screen
      .getByRole("menuitem", { name: "Add label (requires timestamp axis)" })
      .getAttribute("aria-disabled"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("menuitem", { name: "Download plot data as CSV" }));
  expect(view.props.onDownloadCsv).toHaveBeenCalledTimes(1);
  view.cleanup();
});

it("renders distinct overlapping note tags, repositions on scale changes, and edits/deletes", () => {
  state.labels = [label, { ...label, id: "two", title: "Second note" }];
  const view = fixture();
  const button = screen.getByRole("button", { name: `Edit label: ${label.title}` });
  expect(screen.getByLabelText("Timeline labels").style.zIndex).toBe("1001");
  expect(button.querySelector("span")!.style.textOverflow).toBe("ellipsis");
  expect(screen.getByRole("button", { name: "Edit label: Second note" })).toBeDefined();
  expect(button.style.left).toBe("100px");
  act(() => {
    view.props.coordinator.emit("xScaleChanged", { ...scale, min: 0, max: 10 });
  });
  expect(button.style.left).toBe("200px");
  fireEvent.click(button);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Evidence" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(state.updateLabel).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({ comment: "Evidence", startTime: label.startTime }),
  );
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("button", { name: "Delete label" }));
  expect(state.deleteLabel).toHaveBeenCalledWith("one");
  view.cleanup();
});

it("hides labels and open editors immediately when switching recordings", () => {
  state.labels = [label];
  const view = fixture();
  fireEvent.click(screen.getByRole("button", { name: `Edit label: ${label.title}` }));
  jest.mocked(useTimelineLabelSource).mockReturnValue({ ...source, id: "recording-two" });
  view.rerender(<PlotLabels {...view.props} />);
  expect(screen.queryByRole("button", { name: `Edit label: ${label.title}` })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(state.updateLabel).not.toHaveBeenCalled();
  view.cleanup();
});
