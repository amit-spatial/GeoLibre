import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  consumePendingIdentifyRestore,
  createIdentifyPopupState,
  restoreIdentifySelection,
  type IdentifyPopupState,
} from "../packages/map/src/map-identify-lifecycle";
import {
  applySelectionHighlight,
  resolveHighlightIds,
  selectionFitKey,
} from "../packages/map/src/map-selection";
import { geojsonLayer } from "./helpers/layer-fixtures";

// This file pins the contract between the shared Identify-restore marker
// (map-identify-lifecycle) and the selection effect both 2D canvases run
// (map-selection.ts): restoreIdentifySelection writes the restore marker, then
// whichever engine applies that selection — MapboxCanvas inside its store
// subscription, MapCanvas inside its React effect — must see it, and only for
// the exact key that was restored.

const originalActions = {
  selectLayer: useAppStore.getState().selectLayer,
  selectFeatures: useAppStore.getState().selectFeatures,
};

afterEach(() => {
  useAppStore.setState({
    layers: [],
    selectedLayerId: null,
    selectedFeatureId: null,
    selectedFeatureIds: [],
    ...originalActions,
  });
  // Drop any marker a test left behind so it can't leak into the next test.
  consumePendingIdentifyRestore("__drain__");
});

function seedIdentifyHit(): void {
  // "previous" is the selection the user had before Identify; "identified" is
  // what the popup opened on.
  useAppStore.setState({
    layers: [geojsonLayer({ id: "identified" }), geojsonLayer({ id: "previous" })],
    selectedLayerId: "identified",
    selectedFeatureId: "hit",
    selectedFeatureIds: ["hit"],
    ...originalActions,
  });
}

function popupState(patch: Partial<IdentifyPopupState> = {}): IdentifyPopupState {
  return {
    identifiedLayerId: "identified",
    identifiedFeatureId: "hit",
    previousSelectedLayerId: "previous",
    previousSelectedFeatureId: "b",
    previousSelectedFeatureIds: ["a", "b"],
    onClose: () => {},
    ...patch,
  };
}

/**
 * A recording stand-in for MapEngine — we only ever call it the way
 * applySelectionHighlight does internally.
 */
function recordingEngine(): {
  engine: Parameters<typeof applySelectionHighlight>[0];
  highlightCalls: Array<{ featureId: string | string[] | null; fit: boolean | undefined }>;
} {
  const highlightCalls: Array<{ featureId: string | string[] | null; fit: boolean | undefined }> =
    [];
  const engine = {
    highlightFeature(layer: unknown, featureId: string | string[] | null, options?: { fit?: boolean }) {
      void layer;
      highlightCalls.push({
        featureId: featureId ?? null,
        fit: options?.fit,
      });
    },
  } as unknown as Parameters<typeof applySelectionHighlight>[0];
  return { engine, highlightCalls };
}

describe("selectionFitKey", () => {
  it("returns null when there is no layer or no highlighted features", () => {
    assert.equal(
      selectionFitKey({ selectedLayerId: null, selectedFeatureId: "a", selectedFeatureIds: [] }),
      null,
    );
    assert.equal(
      selectionFitKey({
        selectedLayerId: "layer",
        selectedFeatureId: null,
        selectedFeatureIds: [],
      }),
      null,
    );
  });

  it("uses the multi-select set when present, else the anchor, under a collision-proof shape", () => {
    const withMulti = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "a",
      selectedFeatureIds: ["a", "b"],
    });
    assert.equal(withMulti, JSON.stringify(["layer", ["a", "b"]]));

    const anchorOnly = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "solo",
      selectedFeatureIds: [],
    });
    assert.equal(anchorOnly, JSON.stringify(["layer", ["solo"]]));

    // A delimiter-free serialization keeps ["a,b"] distinct from ["a", "b"].
    const embedded = selectionFitKey({
      selectedLayerId: "layer",
      selectedFeatureId: "a,b",
      selectedFeatureIds: [],
    });
    assert.notEqual(embedded, withMulti);
    assert.equal(embedded, JSON.stringify(["layer", ["a,b"]]));
  });
});

describe("restore marker -> fit suppression end-to-end", () => {
  it("suppresses fit exactly once for the restored selection, for both canvas call shapes", () => {
    seedIdentifyHit();
    const layers = useAppStore.getState().layers;

    const { engine, highlightCalls } = recordingEngine();

    simulateCanvasRestoreEffect();

    // --- The MapboxCanvas shape: reads the marker inside a store subscription,
    // before the engine's highlight call — same synchronous call stack as the
    // selectLayer/selectFeatures writes inside restoreIdentifySelection. ---
    let mapboxRestoring = consumePendingIdentifyRestore(
      selectionFitKey({
        selectedLayerId: "previous",
        selectedFeatureId: "b",
        selectedFeatureIds: ["a", "b"],
      }),
    );
    assert.equal(mapboxRestoring, true, "MapboxCanvas (sync subscriber) must observe the restore");
    assert.equal(
      applySelectionHighlight(
        engine,
        layers,
        "previous",
        "b",
        ["a", "b"],
        true,
        null,
        mapboxRestoring,
      ),
      JSON.stringify(["previous", ["a", "b"]]),
    );
    const mbxCall = highlightCalls.at(-1);
    assert.ok(mbxCall);
    assert.equal(mbxCall.fit, false, "restored selection must not re-fit (Mapbox shape)");
    assert.deepEqual(mbxCall.featureId, ["a", "b"], "the full multi-selection is highlighted");

    // The marker is consumed: a re-read must return false.
    assert.equal(
      consumePendingIdentifyRestore(selectionFitKey({ selectedLayerId: "previous", selectedFeatureId: "b", selectedFeatureIds: ["a", "b"] })),
      false,
      "marker must not be reusable after one consumption",
    );

    function simulateCanvasRestoreEffect(): void {
      // restoreIdentifySelection runs first (user-dismissed the popup), then the
      // engine's selection effect reads the marker — for MapCanvas that's a
      // React effect that runs after the restore's call stack finished, for
      // Mapbox a synchronous subscription. The marker is keyed, so both shapes
      // agree on *which* selection this applies to.
      restoreIdentifySelection(popupState());
    }
  });

  it("does not suppress fit for a different (non-restored) selection", () => {
    seedIdentifyHit();
    const { engine, highlightCalls } = recordingEngine();

    restoreIdentifySelection(popupState());
    // A different selection arrives (not the restored one) before the effect
    // reads the marker — e.g. a user clicks another feature right after the
    // popup closes.
    const store = useAppStore.getState();
    store.selectFeatures(["z"], "z");

    const restoring = consumePendingIdentifyRestore(
      selectionFitKey({
        selectedLayerId: "previous",
        selectedFeatureId: "z",
        selectedFeatureIds: ["z"],
      }),
    );
    assert.equal(restoring, false, "a superseding selection is not the restore");
    // The marker should still be consumed as a side effect of a non-matching read.
    assert.equal(
      consumePendingIdentifyRestore(
        selectionFitKey({
          selectedLayerId: "previous",
          selectedFeatureId: "b",
          selectedFeatureIds: ["a", "b"],
        }),
      ),
      false,
    );
  });

  it("a skipped restore (guard: user already changed selection) leaves no marker and no suppression", () => {
    seedIdentifyHit();
    const { engine, highlightCalls } = recordingEngine();

    // The user independently changed the selection while the popup was open.
    const store = useAppStore.getState();
    store.selectLayer("previous");
    store.selectFeature("user");
    store.selectFeatures(["user"], "user");

    restoreIdentifySelection(popupState());

    const currentRestoring = consumePendingIdentifyRestore(
      selectionFitKey({
        selectedLayerId: "previous",
        selectedFeatureId: "user",
        selectedFeatureIds: ["user"],
      }),
    );
    assert.equal(currentRestoring, false, "no restore happened, so no marker to consume");

    const nextKey = applySelectionHighlight(
      engine,
      useAppStore.getState().layers,
      "previous",
      "user",
      ["user"],
      true,
      null,
      currentRestoring,
    );
    assert.equal(nextKey, JSON.stringify(["previous", ["user"]]));
    const call = highlightCalls.at(-1);
    assert.ok(call);
    assert.equal(call.fit, true, "a user selection must still fit normally");
  });
});