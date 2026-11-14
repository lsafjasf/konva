import type { IRect } from './types.ts';
import type { Node } from './Node.ts';
import type { Layer } from './Layer.ts';
import { _boundedShapes } from './Global.ts';

// Dirty-region (partial) redraw support.
//
// A full layer draw repaints every node even when one node moved or one
// attribute changed. The layer instead remembers the painted bounds of every
// node from the previous frame and, on the next draw, repaints only the union
// of the old and new bounds of the nodes whose pixels may have changed.
// Anything that cannot be expressed as a finite bounds union falls back to a
// full redraw, so the rendered scene and the hit graph stay byte-identical to
// a full draw.

// the transform matrix a node was last painted with, in layer coordinates
type NodePaintState = {
  matrix: number[];
};

// per-layer bookkeeping. Hanging it off the Layer keeps a WeakMap-free hot
// path and lets the state be discarded together with the layer.
export type PartialRenderState = {
  // node -> matrix from its last actual paint
  painted: Map<Node, NodePaintState>;
  // nodes explicitly marked as changed since the last frame
  changed: Set<Node>;
  // accumulated dirty rectangles in layer (CSS pixel) coordinates
  regions: IRect[];
  // hit graph regions, which may extend beyond scene regions (hitStrokeWidth)
  hitRegions: IRect[];
  // regions chosen for the running frame, shared by scene and hit canvases
  preparedRegions: IRect[] | null;
  // regions chosen for the running hit frame; undefined until computed
  preparedHitRegions?: IRect[] | null;
  // a structural/sizing/global change makes region tracking inapplicable
  forceFull: boolean;
  // a frame with regions is being rendered right now
  active: boolean;
  // culling rectangles of the running frame, empty while drawing the whole layer
  clipRegions: IRect[];
  // painted bounds computed during the current pre-walk, reused while drawing
  frameBounds: Map<Node, IRect>;
  // the last hit graph is stale because it was skipped while dragging
  hitInvalid: boolean;
};

export function createPartialRenderState(): PartialRenderState {
  return {
    painted: new Map(),
    changed: new Set(),
    regions: [],
    hitRegions: [],
    preparedRegions: null,
    forceFull: false,
    active: false,
    clipRegions: [],
    frameBounds: new Map(),
    hitInvalid: false,
  };
}

export function markNodeChanged(state: PartialRenderState, node: Node) {
  state.changed.add(node);
}

export function addHitDirtyRegion(
  state: PartialRenderState,
  rect?: IRect | null
) {
  if (!rect || !isFiniteRect(rect)) {
    state.forceFull = true;
    return;
  }
  state.hitRegions.push({
    x: Math.floor(rect.x) - 1,
    y: Math.floor(rect.y) - 1,
    width: Math.ceil(rect.width) + 2,
    height: Math.ceil(rect.height) + 2,
  });
}

export function markFullRedraw(state: PartialRenderState) {
  state.forceFull = true;
}

function isFiniteRect(rect: IRect) {
  return (
    isFinite(rect.x) &&
    isFinite(rect.y) &&
    isFinite(rect.width) &&
    isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function addDirtyRegion(state: PartialRenderState, rect?: IRect | null) {
  if (!rect || !isFiniteRect(rect)) {
    state.forceFull = true;
    return;
  }
  // expand outwards so antialiased pixels on the edge are repainted too
  const region = {
    x: Math.floor(rect.x) - 1,
    y: Math.floor(rect.y) - 1,
    width: Math.ceil(rect.width) + 2,
    height: Math.ceil(rect.height) + 2,
  };
  state.regions.push(region);
}

// bounds of a node as painted into the layer, in layer coordinates. Returns
// undefined for anything whose paint cannot be bounded (custom sceneFunc,
// whole-canvas isolation buffers...)
export function getPaintedBounds(node: Node): IRect | undefined {
  try {
    const rect = node.getClientRect({
      _forDrawing: true,
    });
    return isFiniteRect(rect) ? rect : undefined;
  } catch (e) {
    return undefined;
  }
}

// bounds painted into the hit graph. A shape's hit stroke may extend beyond
// its scene bounds (hitStrokeWidth), so the hit regions are computed from the
// scene bounds expanded by the difference between the two.
export function getHitPaintedBounds(node: Node): IRect | undefined {
  const scene = getPaintedBounds(node);
  if (!scene) return undefined;
  const shape = node as unknown as {
    nodeType?: string;
    hasHitStroke?: () => boolean;
    hitStrokeWidth?: () => number | string;
    strokeWidth?: () => number;
  };
  if (shape.nodeType !== 'Shape' || !shape.hasHitStroke?.()) {
    return scene;
  }
  let hitWidth = shape.hitStrokeWidth!();
  if (hitWidth === 'auto') {
    hitWidth = shape.strokeWidth ? shape.strokeWidth() : 0;
  }
  const padding = Math.max(0, (Number(hitWidth) || 0) / 2);
  if (padding === 0) return scene;
  return {
    x: scene.x - padding,
    y: scene.y - padding,
    width: scene.width + padding * 2,
    height: scene.height + padding * 2,
  };
}

export function getPaintedMatrix(state: PartialRenderState, node: Node) {
  return state.painted.get(node)?.matrix;
}

export function rememberMatrix(
  state: PartialRenderState,
  node: Node,
  matrix: number[]
) {
  state.painted.set(node, { matrix: matrix.slice() });
}

export function sameMatrix(a: number[] | undefined, b: number[]) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// A node is cullable only when everything it paints lies inside the bounds
// reported by getClientRect. Built-in shapes register the guarantee; a cached
// node paints its (bounded) cache bitmap; a container's bounds union its
// children. Custom sceneFunc shapes may paint anywhere, so they are never
// culled.
export function isCullable(node: Node): boolean {
  if (node.isCached()) return true;
  if (node.nodeType === 'Group' || node.nodeType === 'Layer') return true;
  if (node.nodeType !== 'Shape') return false;
  const shape = node as unknown as {
    attrs: {
      sceneFunc?: unknown;
      selfRectFunc?: unknown;
      charRenderFunc?: unknown;
    };
    getSelfRect: Function;
  };
  return (
    _boundedShapes.has(node.constructor) ||
    (!!shape.attrs.selfRectFunc &&
      shape.getSelfRect !== undefined &&
      !shape.attrs.sceneFunc &&
      !shape.attrs.charRenderFunc)
  );
}

function rectsIntersect(a: IRect, b: IRect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// whether the painted bounds of a node touch any dirty region of the frame
export function intersectsRegions(
  state: PartialRenderState,
  node: Node,
  bounds: IRect
) {
  if (!state.active || state.clipRegions.length === 0) return true;
  for (const region of state.clipRegions) {
    if (rectsIntersect(bounds, region)) return true;
  }
  return false;
}

// Merge overlapping/adjacent rectangles; keeps the region list short even for
// many changed nodes in one frame.
function mergeRegions(regions: IRect[]): IRect[] {
  const rects = regions.slice().sort((a, b) => a.x - b.x);
  const merged: IRect[] = [];
  for (const rect of rects) {
    const last = merged[merged.length - 1];
    if (last && rect.x <= last.x + last.width + 1) {
      const right = Math.max(last.x + last.width, rect.x + rect.width);
      const bottom = Math.max(last.y + last.height, rect.y + rect.height);
      last.y = Math.min(last.y, rect.y);
      last.width = right - last.x;
      last.height = bottom - last.y;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

function clampToLayer(rect: IRect, layer: Layer): IRect {
  const width = layer.getWidth() || 0;
  const height = layer.getHeight() || 0;
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  return {
    x,
    y,
    width: Math.min(rect.x + rect.width, width) - x,
    height: Math.min(rect.y + rect.height, height) - y,
  };
}

// Finalize the dirty regions for the frame: merge, clamp to the layer and
// drop empty ones. Returns null when a full redraw is required.
export function prepareRegions(
  state: PartialRenderState,
  layer: Layer,
  sourceRegions: IRect[] = state.regions
): IRect[] | null {
  if (state.forceFull || sourceRegions.length === 0) {
    return null;
  }
  const merged = mergeRegions(sourceRegions)
    .map((rect) => clampToLayer(rect, layer))
    .filter((rect) => rect.width > 0 && rect.height > 0);
  return merged.length ? merged : null;
}

// begin a frame: drop per-frame caches but keep the painted matrices
export function beginFrame(state: PartialRenderState, regions: IRect[] | null) {
  state.frameBounds.clear();
  if (regions) {
    state.active = true;
    state.clipRegions = regions;
  } else {
    state.active = false;
    state.clipRegions = [];
  }
}

export function endFrame(state: PartialRenderState) {
  state.active = false;
  state.clipRegions = [];
  state.frameBounds.clear();
}

// release all per-frame inputs once both scene and hit graphs are done
export function releaseFrame(state: PartialRenderState) {
  state.regions = [];
  state.hitRegions = [];
  state.preparedRegions = null;
  state.preparedHitRegions = undefined;
  state.forceFull = false;
  state.changed.clear();
  endFrame(state);
}
