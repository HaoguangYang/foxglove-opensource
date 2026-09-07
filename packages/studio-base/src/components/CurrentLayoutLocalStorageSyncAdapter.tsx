// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createStore as idbCreateStore, get as idbGet, set as idbSet } from "idb-keyval";
import * as _ from "lodash-es";
import { useEffect, useRef, useState } from "react";
import { useDebounce } from "use-debounce";

import Log from "@foxglove/log";
import {
  LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY,
  LOCAL_STORAGE_STUDIO_LAYOUT_KEY,
} from "@foxglove/studio-base/constants/localStorageKeys";
import {
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { defaultLayout } from "@foxglove/studio-base/providers/CurrentLayoutProvider/defaultLayout";
import { migratePanelsState } from "@foxglove/studio-base/services/migrateLayout";

function selectLayoutData(state: LayoutState) {
  return state.selectedLayout?.data;
}

const log = Log.getLogger(__filename);

const IDB_LAYOUT_STORE = idbCreateStore("foxglove-studio-layouts", "layouts");
const IDB_FALLBACK_JOURNAL_VERSION = 1;

type FallbackJournal = {
  version: typeof IDB_FALLBACK_JOURNAL_VERSION;
  layout: LayoutData;
};

function readLegacyLayout(): LayoutData | undefined {
  try {
    const serializedLayoutData = localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY);
    if (!serializedLayoutData) {
      return undefined;
    }
    return migratePanelsState(JSON.parse(serializedLayoutData) as LayoutData);
  } catch (error) {
    log.error(`Failed to read legacy layout from local storage`, error);
    return undefined;
  }
}

function readFallbackJournal(): LayoutData | undefined {
  try {
    const serializedJournal = localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY);
    if (!serializedJournal) {
      return undefined;
    }
    const journal = JSON.parse(serializedJournal) as Partial<FallbackJournal>;
    if (journal.version !== IDB_FALLBACK_JOURNAL_VERSION || !journal.layout) {
      throw new Error("Invalid IndexedDB fallback journal");
    }
    return migratePanelsState(journal.layout);
  } catch (error) {
    log.error(`Failed to read IndexedDB fallback journal`, error);
    return undefined;
  }
}

function writeFallbackJournal(layoutData: LayoutData): boolean {
  try {
    const serializedJournal = JSON.stringify({
      version: IDB_FALLBACK_JOURNAL_VERSION,
      layout: layoutData,
    } satisfies FallbackJournal);
    if (!serializedJournal) {
      throw new Error("Layout data could not be serialized");
    }
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY, serializedJournal);
    return true;
  } catch (error) {
    log.error(`Failed to persist IndexedDB fallback journal`, error);
    return false;
  }
}

function clearFallbackJournal(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_STUDIO_LAYOUT_IDB_FALLBACK_KEY);
  } catch (error) {
    log.error(`Failed to clear IndexedDB fallback journal`, error);
  }
}

function hasSampleLayout(sampleLayoutRef: { current: LayoutData | undefined }): boolean {
  return sampleLayoutRef.current != undefined;
}

export function CurrentLayoutLocalStorageSyncAdapter(): JSX.Element {
  const { selectedSource } = usePlayerSelection();

  const { setCurrentLayout } = useCurrentLayoutActions();
  const currentLayoutData = useCurrentLayoutSelector(selectLayoutData);
  const [hydrated, setHydrated] = useState(false);
  const persistedLayoutRef = useRef<LayoutData | undefined>();
  const restoreTokenRef = useRef<symbol | undefined>();
  const layoutFromFailedReadRef = useRef<LayoutData | undefined>();
  const sampleLayoutRef = useRef<LayoutData | undefined>();
  sampleLayoutRef.current = selectedSource?.sampleLayout;

  useEffect(() => {
    if (selectedSource?.sampleLayout) {
      restoreTokenRef.current = undefined;
      setCurrentLayout({ data: selectedSource.sampleLayout });
      setHydrated(true);
    }
  }, [selectedSource, setCurrentLayout]);

  const [debouncedLayoutData] = useDebounce(currentLayoutData, 250, { maxWait: 500 });

  useEffect(() => {
    // Do not let the initial, transient layout overwrite a layout that is still loading from IDB.
    // The identity check also waits for useDebounce to catch up after the restore changes the layout.
    if (
      !hydrated ||
      !debouncedLayoutData ||
      debouncedLayoutData !== currentLayoutData ||
      debouncedLayoutData === persistedLayoutRef.current
    ) {
      return;
    }

    // A rejected read does not prove that IndexedDB is empty. Avoid replaying exactly the
    // fallback layout into it, but permit a later user edit to retry IndexedDB persistence.
    if (debouncedLayoutData === layoutFromFailedReadRef.current) {
      return;
    }
    layoutFromFailedReadRef.current = undefined;

    void idbSet(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, debouncedLayoutData, IDB_LAYOUT_STORE)
      .then(() => {
        persistedLayoutRef.current = debouncedLayoutData;
        clearFallbackJournal();
      })
      .catch((error) => {
        log.error(`Failed to persist layout to IndexedDB`, error);
        if (writeFallbackJournal(debouncedLayoutData)) {
          persistedLayoutRef.current = debouncedLayoutData;
        }
      });
  }, [currentLayoutData, debouncedLayoutData, hydrated]);

  useEffect(() => {
    const restoreToken = Symbol("layout restore");
    restoreTokenRef.current = restoreToken;

    void (async () => {
      let layoutData: LayoutData;
      const fallbackJournalLayout = readFallbackJournal();
      if (hasSampleLayout(sampleLayoutRef)) {
        return;
      }
      try {
        log.debug(`Reading layout from IndexedDB: ${LOCAL_STORAGE_STUDIO_LAYOUT_KEY}`);
        const storedLayoutData = await idbGet<LayoutData>(
          LOCAL_STORAGE_STUDIO_LAYOUT_KEY,
          IDB_LAYOUT_STORE,
        );
        if (fallbackJournalLayout) {
          layoutData = fallbackJournalLayout;
          try {
            await idbSet(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, layoutData, IDB_LAYOUT_STORE);
            persistedLayoutRef.current = layoutData;
            clearFallbackJournal();
          } catch (error) {
            log.error(`Failed to reconcile IndexedDB fallback journal`, error);
          }
        } else if (storedLayoutData) {
          layoutData = migratePanelsState(storedLayoutData);
          // Normal migrations clone the layout. Keep the hydrated layout pending when its
          // contents changed so the debounced writer stores the migrated representation once.
          persistedLayoutRef.current = _.isEqual(storedLayoutData, layoutData)
            ? layoutData
            : undefined;
        } else {
          const legacyLayoutData = readLegacyLayout();
          if (legacyLayoutData) {
            try {
              await idbSet(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, legacyLayoutData, IDB_LAYOUT_STORE);
              persistedLayoutRef.current = legacyLayoutData;
              localStorage.removeItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY);
            } catch (error) {
              log.error(`Failed to migrate legacy layout to IndexedDB`, error);
            }
            layoutData = legacyLayoutData;
          } else {
            layoutData = migratePanelsState(defaultLayout);
          }
        }
      } catch (error) {
        log.error(`Failed to read layout from IndexedDB`, error);
        // A read failure is not an empty database. Never use a fallback layout to overwrite
        // IDB, which may contain newer data that becomes readable again later.
        layoutData = fallbackJournalLayout ?? readLegacyLayout() ?? migratePanelsState(defaultLayout);
        layoutFromFailedReadRef.current = layoutData;
      }

      if (restoreTokenRef.current !== restoreToken || hasSampleLayout(sampleLayoutRef)) {
        return;
      }
      setCurrentLayout({ data: layoutData });
      setHydrated(true);
    })();

    return () => {
      if (restoreTokenRef.current === restoreToken) {
        restoreTokenRef.current = undefined;
      }
    };
  }, [setCurrentLayout]);

  return <></>;
}
