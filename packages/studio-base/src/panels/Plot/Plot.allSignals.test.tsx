/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";

import MockMessagePipelineProvider from "@foxglove/studio-base/components/MessagePipeline/MockMessagePipelineProvider";
import MockPanelContextProvider from "@foxglove/studio-base/components/MockPanelContextProvider";
import { createLabelsExport } from "@foxglove/studio-base/components/TimelineLabels/export";
import { createSourceDescriptor } from "@foxglove/studio-base/components/TimelineLabels/source";
import {
  createTimelineLabelsStore,
  getTimelineLabelsStore,
} from "@foxglove/studio-base/components/TimelineLabels/store";
import MockCurrentLayoutProvider from "@foxglove/studio-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";
import TimelineInteractionStateProvider from "@foxglove/studio-base/providers/TimelineInteractionStateProvider";

import { Plot } from "./Plot";
import { PlotConfig, PlotPath } from "./config";

// The plots, source context, label editor, persistence, and export stay real.
// Canvas workers cannot run under jsdom; replace the chart rendering boundary only.
jest.mock("./OffscreenCanvasRenderer", () => ({ OffscreenCanvasRenderer: jest.fn() }));
jest.mock("./builders/TimestampDatasetsBuilder", () => ({ TimestampDatasetsBuilder: jest.fn() }));
jest.mock("./settings", () => ({ usePlotPanelSettings: () => {} }));
jest.mock("./PlotLegend", () => ({ PlotLegend: () => <></> }));
jest.mock("@foxglove/studio-base/components/PanelToolbar", () => ({
  __esModule: true,
  default: () => <></>,
  PANEL_TOOLBAR_MIN_HEIGHT: 24,
}));
jest.mock("./PlotCoordinator", () => {
  const Emitter = jest.requireActual("eventemitter3");
  return {
    PlotCoordinator: class extends Emitter {
      public handleConfig() {}
      public handlePlayerState() {}
      public setSize() {}
      public destroy() {}
      public setGlobalBounds() {}
      public getXScale() {
        return { min: 0, max: 20, left: 50, right: 550, top: 10, bottom: 250 };
      }
      public getXValueAtPixel() {
        return 0;
      }
    },
  };
});

const startTime = { sec: 1700000000, nsec: 123456789 };
const endTime = { sec: 1700000020, nsec: 123456789 };
const source = createSourceDescriptor({ name: "one.mcap", activeData: { startTime, endTime } })!;
const path = (
  value: string,
  timestampMethod: PlotPath["timestampMethod"] = "receiveTime",
): PlotPath => ({ value, enabled: true, timestampMethod });
const config = (paths: PlotPath[]): PlotConfig => ({
  paths,
  xAxisVal: "timestamp",
  showLegend: false,
  legendDisplay: "none",
  isSynced: false,
  showXAxisLabels: true,
  showYAxisLabels: true,
  showPlotValuesInLegend: false,
  sidebarDimension: 0,
});

function SinglePlot({ paths, name = "one.mcap" }: { paths: PlotPath[]; name?: string }) {
  return (
    <MockMessagePipelineProvider
      name={name}
      startTime={startTime}
      endTime={endTime}
      currentTime={startTime}
    >
      <MockPanelContextProvider>
        <Plot config={config(paths)} saveConfig={() => {}} />
      </MockPanelContextProvider>
    </MockMessagePipelineProvider>
  );
}

function TwoPlots({
  left,
  right,
  rightName,
  separateApp = false,
}: {
  left: PlotPath[];
  right?: PlotPath[];
  rightName?: string;
  separateApp?: boolean;
}) {
  const second = right && (
    <div data-testid="right-plot">
      <SinglePlot paths={right} name={rightName} />
    </div>
  );
  return (
    <StrictMode>
      <TimelineInteractionStateProvider>
        <MockCurrentLayoutProvider>
          <div data-testid="left-plot">
            <SinglePlot paths={left} />
          </div>
          {separateApp ? <MockCurrentLayoutProvider>{second}</MockCurrentLayoutProvider> : second}
        </MockCurrentLayoutProvider>
      </TimelineInteractionStateProvider>
    </StrictMode>
  );
}

function exported() {
  return createLabelsExport(createTimelineLabelsStore(() => window.localStorage).getState().labels)
    .labels;
}

function editLeft() {
  fireEvent.click(
    within(screen.getByTestId("left-plot")).getByRole("button", { name: "Edit label: Existing" }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  const store = getTimelineLabelsStore();
  store.getState().refresh();
  store
    .getState()
    .addLabel({
      title: "Existing",
      comment: "Original",
      source,
      startTime: { ...startTime, sec: startTime.sec + 4 },
      endTime: { ...startTime, sec: startTime.sec + 8 },
      signalExpressions: ["/old.value"],
      signalMetadata: [{ expression: "/old.value", timestampMethod: "receiveTime" }],
    });
  HTMLCanvasElement.prototype.transferControlToOffscreen = jest.fn();
  HTMLElement.prototype.setPointerCapture = jest.fn();
  HTMLElement.prototype.releasePointerCapture = jest.fn();
  HTMLElement.prototype.hasPointerCapture = jest.fn().mockReturnValue(true);
  globalThis.ResizeObserver = class {
    public observe() {}
    public unobserve() {}
    public disconnect() {}
  };
});

it("saves the union from actual open Plots and keeps both timestamp conventions for duplicate expressions", () => {
  render(
    <TwoPlots
      left={[path("/shared.value"), path("/left.value"), path("123")]}
      right={[
        path("/shared.value"),
        path("/shared.value", "headerStamp"),
        path("/right.value"),
        { ...path("/hidden.value"), enabled: false },
      ]}
    />,
  );
  editLeft();
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]).toMatchObject({
    signalExpressions: ["/shared.value", "/left.value", "/right.value"],
    signalMetadata: [
      { expression: "/shared.value", timestampMethod: "receiveTime" },
      { expression: "/left.value", timestampMethod: "receiveTime" },
      { expression: "/shared.value", timestampMethod: "headerStamp" },
      { expression: "/right.value", timestampMethod: "receiveTime" },
    ],
  });
});

it("uses changes in another Plot while the editor is open and removes closed contributions", () => {
  const view = render(<TwoPlots left={[path("/left.value")]} right={[path("/old.value")]} />);
  editLeft();
  view.rerender(
    <TwoPlots
      left={[path("/left.value")]}
      right={[{ ...path("/old.value"), enabled: false }, path("/new.value", "headerStamp")]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]).toMatchObject({
    signalExpressions: ["/left.value", "/new.value"],
    signalMetadata: [
      { expression: "/left.value", timestampMethod: "receiveTime" },
      { expression: "/new.value", timestampMethod: "headerStamp" },
    ],
  });
  editLeft();
  view.rerender(<TwoPlots left={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]).toMatchObject({ signalExpressions: [], signalMetadata: [] });
});

it("excludes other sources and removes contributions when a mounted Plot switches recordings", () => {
  const view = render(<TwoPlots left={[path("/left.value")]} right={[path("/right.value")]} />);
  editLeft();
  view.rerender(
    <TwoPlots left={[path("/left.value")]} right={[path("/other.value")]} rightName="other.mcap" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]?.signalExpressions).toEqual(["/left.value"]);
  editLeft();
  view.rerender(<TwoPlots left={[path("/left.value")]} right={[path("/returned.value")]} />);
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]?.signalExpressions).toEqual(["/left.value", "/returned.value"]);
});

it("does not mix another app root showing the same source", () => {
  render(<TwoPlots left={[path("/left.value")]} right={[path("/other-app.value")]} separateApp />);
  editLeft();
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported()[0]?.signalExpressions).toEqual(["/left.value"]);
});

it("does not change persisted annotations when another Plot changes and editing is canceled", () => {
  const view = render(<TwoPlots left={[path("/left.value")]} right={[path("/right.value")]} />);
  const original = window.localStorage.getItem("foxglove.timeline-labels.v1");
  editLeft();
  view.rerender(<TwoPlots left={[]} right={[]} />);
  fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(window.localStorage.getItem("foxglove.timeline-labels.v1")).toBe(original);
});

it("creates a new label with the all-Plot union at Save time", () => {
  const view = render(<TwoPlots left={[path("/left.value")]} right={[path("/right.value")]} />);
  const canvas = within(screen.getByTestId("left-plot")).getByLabelText(/Plot chart/);
  for (const [type, x] of [
    ["pointerdown", 150],
    ["pointermove", 250],
    ["pointerup", 250],
  ] as const) {
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 200 });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(canvas, event);
  }
  fireEvent.contextMenu(canvas);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add label" }));
  view.rerender(<TwoPlots left={[path("/left.value")]} right={[path("/changed.value")]} />);
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "New note" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(exported().find((label) => label.title === "New note")?.signalExpressions).toEqual([
    "/left.value",
    "/changed.value",
  ]);
});
