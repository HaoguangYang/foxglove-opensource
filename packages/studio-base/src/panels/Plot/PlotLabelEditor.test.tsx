/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fireEvent, render, screen } from "@testing-library/react";

import { LabelDraft, PlotLabelEditor } from "./PlotLabelEditor";

const draft: LabelDraft = {
  id: "one",
  title: "Failure",
  comment: "Signal diverges",
  startTime: { sec: 1700000000, nsec: 123456789 },
  endTime: { sec: 1700000001, nsec: 987654321 },
};

it("edits content while preserving exact unedited nanoseconds", () => {
  const onSave = jest.fn();
  render(
    <PlotLabelEditor draft={draft} onSave={onSave} onDelete={jest.fn()} onClose={jest.fn()} />,
  );
  fireEvent.change(screen.getByLabelText("Comment"), {
    target: { value: "Ground truth confirmed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(onSave).toHaveBeenCalledWith({ ...draft, comment: "Ground truth confirmed" });
});

it("validates empty title and reversed or malformed time range", () => {
  const onSave = jest.fn();
  render(
    <PlotLabelEditor
      draft={{ ...draft, title: "" }}
      onSave={onSave}
      onDelete={jest.fn()}
      onClose={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(screen.getByText("Enter a title.")).toBeDefined();
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Timing" } });
  fireEvent.change(screen.getByLabelText("End time (UTC)"), {
    target: { value: "2020-01-01 00:00:00.123" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(screen.getByText("End time must be at or after start time.")).toBeDefined();
  fireEvent.change(screen.getByLabelText("End time (UTC)"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Save label" }));
  expect(screen.getByText("Enter valid UTC dates and times.")).toBeDefined();
  expect(onSave).not.toHaveBeenCalled();
});

it("cancels without mutation and deletes only on explicit delete", () => {
  const onSave = jest.fn();
  const onClose = jest.fn();
  const onDelete = jest.fn();
  render(<PlotLabelEditor draft={draft} onSave={onSave} onDelete={onDelete} onClose={onClose} />);
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onSave).not.toHaveBeenCalled();
  expect(onDelete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Delete label" }));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
