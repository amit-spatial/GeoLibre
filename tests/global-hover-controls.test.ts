import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { projectFromStore, useAppStore, undo } from "@geolibre/core";
import { setHistoryCoalesceMs } from "../packages/core/src/history";

const emptyFC = { type: "FeatureCollection" as const, features: [] };
const state = () => useAppStore.getState();

describe("global hover controls", () => {
  let firstId: string;
  let secondId: string;

  beforeEach(() => {
    setHistoryCoalesceMs(0);
    state().newProject({ name: "Hover controls" });
    firstId = state().addGeoJsonLayer("First", emptyFC);
    secondId = state().addGeoJsonLayer("Second", emptyFC);
    state().setLayerPopup(firstId, {
      hover: true,
      click: false,
      fields: [{ field: "distance_km", hover: true }],
    });
    state().loadProject(projectFromStore(state()));
    useAppStore.temporal.getState().clear();
  });

  it("temporarily hides hovers without editing the project or undo history", () => {
    state().setHoverTooltipsEnabled(false);
    assert.equal(state().hoverTooltipsEnabled, false);
    assert.equal(state().layers[0].popup?.hover, true);
    assert.equal(state().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
    state().setHoverTooltipsEnabled(true);
    assert.equal(state().layers[0].popup?.hover, true);
  });

  it("clears all saved hover enables in one undo step and restores opened defaults", () => {
    state().resetLayerHovers("clear");
    assert.equal(state().layers[0].popup?.hover, undefined);
    assert.equal(state().layers[0].popup?.click, false);
    assert.deepEqual(state().layers[0].popup?.fields, [{ field: "distance_km", hover: true }]);
    assert.equal(state().layers[1].popup, undefined);
    assert.equal(state().isDirty, true);
    assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
    undo();
    assert.equal(state().layers[0].popup?.hover, true);
    state().resetLayerHovers("clear");
    state().resetLayerHovers("project");
    assert.equal(state().layers[0].popup?.hover, true);
    assert.equal(state().layers[1].popup, undefined);
  });

  it("resets the temporary switch and project baseline when a new project opens", () => {
    state().setHoverTooltipsEnabled(false);
    state().newProject({ name: "Next" });
    assert.equal(state().hoverTooltipsEnabled, true);
    assert.deepEqual(state().projectHoverDefaults, {});
    assert.equal(state().layers.length, 0);
    assert.notEqual(firstId, secondId);
  });

  it("restores an explicit off flag from the opened project", () => {
    state().setLayerPopup(secondId, { hover: false, click: false });
    state().loadProject(projectFromStore(state()));
    state().resetLayerHovers("clear");
    assert.equal(state().layers[1].popup?.hover, undefined);
    state().resetLayerHovers("project");
    assert.equal(state().layers[1].popup?.hover, false);
    assert.equal(state().layers[1].popup?.click, false);
  });
});
