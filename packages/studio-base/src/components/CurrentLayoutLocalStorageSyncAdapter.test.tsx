/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { act, render, waitFor } from "@testing-library/react";
import * as idbKeyval from "idb-keyval";
import { createStore, del, get, set } from "idb-keyval";
import { useEffect } from "react";

import {
  LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY,
  LOCAL_STORAGE_STUDIO_LAYOUT_KEY,
} from "@foxglove/studio-base/constants/localStorageKeys";
import {
  LayoutData,
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import PlayerSelectionContext, {
  IDataSourceFactory,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import MockCurrentLayoutProvider from "@foxglove/studio-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";

import { CurrentLayoutLocalStorageSyncAdapter } from "./CurrentLayoutLocalStorageSyncAdapter";

const LAYOUT_IDB_KEY = "studio.layout";
const LAYOUT_IDB_STORE = createStore("foxglove-studio-layouts", "layouts");

type LayoutSnapshot = {
  data: LayoutData | undefined;
  setLayout: (data: LayoutData) => void;
};

type UrdfPanelConfig = {
  layers?: Record<
    string,
    {
      localPackage?: { files: Record<string, { data: string }> };
    }
  >;
};

function selectCurrentLayoutData(state: LayoutState) {
  return state.selectedLayout?.data;
}

function getWheelAssetData(layoutData: LayoutData | undefined): string | undefined {
  const panelConfig = layoutData?.configById["3D!robot"] as UrdfPanelConfig | undefined;
  return panelConfig?.layers?.robot?.localPackage?.files["meshes/wheel.stl"]?.data;
}

function makeLayout(name: string, assetData = ""): LayoutData {
  return {
    configById: {
      "3D!robot": {
        layers: {
          robot: {
            layerId: "foxglove.Urdf",
            sourceType: "localFiles",
            localPackage: {
              version: 1,
              id: name,
              packageName: name,
              urdfPath: "urdf/robot.urdf",
              files: {
                "urdf/robot.urdf": { data: "PHJvYm90Lz4=" },
                "meshes/wheel.stl": { data: assetData },
              },
            },
          },
        },
      },
    },
    globalVariables: {},
    playbackConfig: { speed: 1 },
    userNodes: {},
    layout: "3D!robot",
  };
}

function makeSampleSource(sampleLayout: LayoutData): IDataSourceFactory {
  return {
    id: "sample-source",
    type: "sample",
    displayName: "Sample source",
    sampleLayout,
    initialize: () => undefined,
  };
}

function LayoutProbe({ onChange }: { onChange: (snapshot: LayoutSnapshot) => void }): JSX.Element {
  const data = useCurrentLayoutSelector(selectCurrentLayoutData);
  const { setCurrentLayout } = useCurrentLayoutActions();

  useEffect(() => {
    onChange({
      data,
      setLayout: (nextData) => {
        setCurrentLayout({ data: nextData });
      },
    });
  }, [data, onChange, setCurrentLayout]);

  return <></>;
}

function renderAdapter(
  initialState: Partial<LayoutData> = {},
  initialSelectedSource?: IDataSourceFactory,
) {
  let snapshot: LayoutSnapshot | undefined;
  const makeTree = (selectedSource?: IDataSourceFactory) => (
    <PlayerSelectionContext.Provider
      value={{
        selectSource: () => {},
        selectRecent: () => {},
        selectedSource,
        availableSources: [],
        recentSources: [],
      }}
    >
      <MockCurrentLayoutProvider initialState={initialState}>
        <CurrentLayoutLocalStorageSyncAdapter />
        <LayoutProbe
          onChange={(nextSnapshot) => {
            snapshot = nextSnapshot;
          }}
        />
      </MockCurrentLayoutProvider>
    </PlayerSelectionContext.Provider>
  );
  const handle = render(makeTree(initialSelectedSource));

  return {
    ...handle,
    getSnapshot: () => snapshot,
    setSelectedSource: (selectedSource?: IDataSourceFactory) => {
      handle.rerender(makeTree(selectedSource));
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

function expectAndClearLoggedErrors(count: number) {
  expect(console.error).toHaveBeenCalledTimes(count);
  (console.error as jest.Mock).mockClear();
}

function serializedFallbackJournal(layout: LayoutData): string {
  const serializedJournal = JSON.stringify({ version: 1, layout });
  if (!serializedJournal) {
    throw new Error("Expected a serializable fallback journal");
  }
  return serializedJournal;
}

async function waitForDebouncedPersistence() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
}

describe("CurrentLayoutLocalStorageSyncAdapter", () => {
  beforeEach(async () => {
    localStorage.clear();
    await del(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE);
  });

  afterEach(async () => {
    localStorage.clear();
    await del(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE);
  });

  // This catches a regression where browser-imported URDF bytes exceed localStorage's quota.
  it("persists and restores a layout with a 6.39 MB embedded URDF package outside localStorage", async () => {
    const packageBytes = "x".repeat(6_390_000);
    const largeLayout = makeLayout("large-robot", packageBytes);
    const setItem = jest.spyOn(Storage.prototype, "setItem");
    const firstMount = renderAdapter();

    await waitFor(() => {
      expect(firstMount.getSnapshot()?.data).toBeDefined();
    });

    act(() => {
      firstMount.getSnapshot()!.setLayout(largeLayout);
    });

    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(largeLayout);
    });
    expect(
      setItem.mock.calls.some(
        ([key, value]) => key === LOCAL_STORAGE_STUDIO_LAYOUT_KEY && value.length > 5_000_000,
      ),
    ).toBe(false);

    firstMount.unmount();
    const secondMount = renderAdapter();
    await waitFor(() => {
      expect(getWheelAssetData(secondMount.getSnapshot()?.data)).toBe(packageBytes);
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  // This catches a regression where legacy layouts are neither moved nor cleared, repeatedly using quota-bound storage.
  it("migrates a legacy localStorage layout once before removing the legacy key", async () => {
    const legacyLayout = makeLayout("legacy-robot", "legacy-bytes");
    const serializedLegacyLayout = JSON.stringify(legacyLayout);
    if (!serializedLegacyLayout) {
      throw new Error("Expected a serializable legacy layout");
    }
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedLegacyLayout);

    const mount = renderAdapter();
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(legacyLayout);
    });

    expect(mount.getSnapshot()?.data).toEqual(legacyLayout);
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBeNull();
  });

  // This catches a race where the initial default layout is written before an asynchronous restore completes.
  it("does not overwrite an IndexedDB layout while restoration is pending", async () => {
    const storedLayout = makeLayout("stored-robot", "stored-bytes");
    const read = deferred<LayoutData | undefined>();
    const getSpy = jest.spyOn(idbKeyval, "get").mockReturnValueOnce(read.promise);
    const setSpy = jest.spyOn(idbKeyval, "set");
    const mount = renderAdapter(makeLayout("transient-default", "default-bytes"));

    await waitFor(() => {
      expect(getSpy).toHaveBeenCalled();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(setSpy).not.toHaveBeenCalled();

    await act(async () => {
      read.resolve(storedLayout);
      await read.promise;
    });
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(storedLayout);
    });
  });

  // This catches a regression where a temporary IndexedDB write failure makes normal layouts disappear after reload.
  it("persists a small layout in a fallback journal when IndexedDB persistence fails", async () => {
    const smallLayout = makeLayout("small-robot", "small-bytes");
    jest.spyOn(idbKeyval, "set").mockRejectedValue(new Error("IndexedDB unavailable"));
    const firstMount = renderAdapter();

    await waitFor(() => {
      expect(firstMount.getSnapshot()?.data).toBeDefined();
    });
    act(() => {
      firstMount.getSnapshot()!.setLayout(smallLayout);
    });

    await waitFor(() => {
      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBe(
        serializedFallbackJournal(smallLayout),
      );
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBeNull();
    expectAndClearLoggedErrors(1);

    firstMount.unmount();
    const secondMount = renderAdapter();
    await waitFor(() => {
      expect(secondMount.getSnapshot()?.data).toEqual(smallLayout);
    });
    expectAndClearLoggedErrors(1);
    secondMount.unmount();
  });

  // This catches a recovered database replacing the newer layout captured by a failed write.
  it("reconciles a newer fallback journal when IndexedDB recovers", async () => {
    const idbLayout = makeLayout("idb-robot", "idb-bytes");
    const newerLayout = makeLayout("newer-robot", "newer-bytes");
    await set(LAYOUT_IDB_KEY, idbLayout, LAYOUT_IDB_STORE);
    jest.spyOn(idbKeyval, "set").mockRejectedValueOnce(new Error("Temporary IndexedDB failure"));

    const firstMount = renderAdapter();
    await waitFor(() => {
      expect(firstMount.getSnapshot()?.data).toEqual(idbLayout);
    });
    act(() => {
      firstMount.getSnapshot()!.setLayout(newerLayout);
    });
    await waitFor(() => {
      expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBe(
        serializedFallbackJournal(newerLayout),
      );
    });
    expectAndClearLoggedErrors(1);

    firstMount.unmount();
    const secondMount = renderAdapter();
    await waitFor(() => {
      expect(secondMount.getSnapshot()?.data).toEqual(newerLayout);
    });
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(newerLayout);
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBeNull();
  });

  it("uses a fallback journal before legacy migration when IndexedDB is empty", async () => {
    const journalLayout = makeLayout("journal-robot", "journal-bytes");
    const legacyLayout = makeLayout("legacy-robot", "legacy-bytes");
    localStorage.setItem(
      LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY,
      serializedFallbackJournal(journalLayout),
    );
    const serializedLegacyLayout = JSON.stringify(legacyLayout);
    if (!serializedLegacyLayout) {
      throw new Error("Expected a serializable legacy layout");
    }
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedLegacyLayout);

    const mount = renderAdapter();
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(journalLayout);
    });
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(journalLayout);
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBeNull();
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY)).toBe(serializedLegacyLayout);
  });

  it("restores a fallback journal without overwriting IndexedDB after a read failure", async () => {
    const newerIdbLayout = makeLayout("newer-robot", "newer-bytes");
    const journalLayout = makeLayout("journal-robot", "journal-bytes");
    const staleLegacyLayout = makeLayout("stale-robot", "stale-bytes");
    await set(LAYOUT_IDB_KEY, newerIdbLayout, LAYOUT_IDB_STORE);
    localStorage.setItem(
      LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY,
      serializedFallbackJournal(journalLayout),
    );
    const serializedLegacyLayout = JSON.stringify(staleLegacyLayout);
    if (!serializedLegacyLayout) {
      throw new Error("Expected a serializable stale legacy layout");
    }
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedLegacyLayout);
    jest.spyOn(idbKeyval, "get").mockRejectedValueOnce(new Error("Transient IndexedDB read failure"));

    const mount = renderAdapter();
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(journalLayout);
    });
    await waitForDebouncedPersistence();
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(newerIdbLayout);
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBe(
      serializedFallbackJournal(journalLayout),
    );
    expectAndClearLoggedErrors(1);
  });

  it("persists an explicit edit after a rejected IndexedDB read", async () => {
    const idbLayout = makeLayout("idb-robot", "idb-bytes");
    const journalLayout = makeLayout("journal-robot", "journal-bytes");
    const editedLayout = makeLayout("edited-robot", "edited-bytes");
    await set(LAYOUT_IDB_KEY, idbLayout, LAYOUT_IDB_STORE);
    localStorage.setItem(
      LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY,
      serializedFallbackJournal(journalLayout),
    );
    jest.spyOn(idbKeyval, "get").mockRejectedValueOnce(new Error("Transient IndexedDB read failure"));

    const firstMount = renderAdapter();
    await waitFor(() => {
      expect(firstMount.getSnapshot()?.data).toEqual(journalLayout);
    });
    expectAndClearLoggedErrors(1);

    act(() => {
      firstMount.getSnapshot()!.setLayout(editedLayout);
    });
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(editedLayout);
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBeNull();

    firstMount.unmount();
    const secondMount = renderAdapter();
    await waitFor(() => {
      expect(secondMount.getSnapshot()?.data).toEqual(editedLayout);
    });
  });

  it("clears a fallback journal after a later normal IndexedDB save", async () => {
    const idbLayout = makeLayout("idb-robot", "idb-bytes");
    const fallbackLayout = makeLayout("fallback-robot", "fallback-bytes");
    const currentLayout = makeLayout("current-robot", "current-bytes");
    await set(LAYOUT_IDB_KEY, idbLayout, LAYOUT_IDB_STORE);
    jest.spyOn(idbKeyval, "set").mockRejectedValueOnce(new Error("Temporary IndexedDB failure"));

    const mount = renderAdapter();
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(idbLayout);
    });
    act(() => {
      mount.getSnapshot()!.setLayout(fallbackLayout);
    });
    await waitFor(() => {
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBe(
        serializedFallbackJournal(fallbackLayout),
      );
    });
    expectAndClearLoggedErrors(1);

    act(() => {
      mount.getSnapshot()!.setLayout(currentLayout);
    });
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(currentLayout);
    });
    expect(localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY)).toBeNull();
  });

  // This catches the original uncaught effect error if the emergency localStorage fallback is too large.
  it("keeps a huge layout in memory when both IndexedDB and localStorage persistence fail", async () => {
    const hugeLayout = makeLayout("huge-robot", "x".repeat(6_390_000));
    jest.spyOn(idbKeyval, "set").mockRejectedValue(new Error("IndexedDB unavailable"));
    const setItem = jest
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation((key: string, _value: string) => {
        if (key === LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY) {
          throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        }
      });
    const mount = renderAdapter();

    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toBeDefined();
    });
    act(() => {
      mount.getSnapshot()!.setLayout(hugeLayout);
    });

    await waitFor(() => {
      expect(setItem).toHaveBeenCalled();
    });
    expect(mount.getSnapshot()?.data).toEqual(hugeLayout);
    expectAndClearLoggedErrors(2);
  });

  // This catches migrations being applied in memory but discarded, forcing the same migration on every launch.
  it("writes a migrated IndexedDB layout back after hydration", async () => {
    const migratedLayout = makeLayout("migrated-robot", "migrated-bytes");
    const legacyIdbLayout = {
      ...migratedLayout,
      configById: undefined,
      savedProps: migratedLayout.configById,
    } as unknown as LayoutData;
    await set(LAYOUT_IDB_KEY, legacyIdbLayout, LAYOUT_IDB_STORE);

    const mount = renderAdapter();
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(migratedLayout);
    });
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(migratedLayout);
    });
  });

  // This catches a rejected IndexedDB read being treated as an empty database and overwriting newer IDB data with stale local data.
  it("does not overwrite IndexedDB with a legacy layout after an IndexedDB read failure", async () => {
    const newerIdbLayout = makeLayout("newer-robot", "newer-bytes");
    const staleLegacyLayout = makeLayout("stale-robot", "stale-bytes");
    await set(LAYOUT_IDB_KEY, newerIdbLayout, LAYOUT_IDB_STORE);
    const serializedStaleLayout = JSON.stringify(staleLegacyLayout);
    if (!serializedStaleLayout) {
      throw new Error("Expected a serializable stale legacy layout");
    }
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedStaleLayout);
    jest.spyOn(idbKeyval, "get").mockRejectedValueOnce(new Error("Transient IndexedDB read failure"));

    const firstMount = renderAdapter();
    await waitFor(() => {
      expect(firstMount.getSnapshot()?.data).toEqual(staleLegacyLayout);
    });
    await waitForDebouncedPersistence();
    await waitFor(async () => {
      expect(await get<LayoutData>(LAYOUT_IDB_KEY, LAYOUT_IDB_STORE)).toEqual(newerIdbLayout);
    });
    expectAndClearLoggedErrors(1);

    firstMount.unmount();
    const secondMount = renderAdapter();
    await waitFor(() => {
      expect(secondMount.getSnapshot()?.data).toEqual(newerIdbLayout);
    });
  });

  // This catches a delayed initial restore replacing a sample source's layout after that source has been selected.
  it("does not let a delayed restore replace a newly selected sample layout", async () => {
    const storedLayout = makeLayout("stored-robot", "stored-bytes");
    const sampleLayout = makeLayout("sample-robot", "sample-bytes");
    const read = deferred<LayoutData | undefined>();
    jest.spyOn(idbKeyval, "get").mockReturnValueOnce(read.promise);
    const mount = renderAdapter();

    mount.setSelectedSource(makeSampleSource(sampleLayout));
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(sampleLayout);
    });
    await act(async () => {
      read.resolve(storedLayout);
      await read.promise;
    });
    await waitFor(() => {
      expect(mount.getSnapshot()?.data).toEqual(sampleLayout);
    });
  });
});
