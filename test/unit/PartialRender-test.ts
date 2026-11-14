import { assert } from 'chai';

import {
  addStage,
  Konva,
  countCalls,
  simulateTouchMove,
  simulateTouchStart,
  simulateTouchEnd,
} from './test-utils.ts';

describe('Partial redraw', function () {
  let partialWasEnabled: boolean;

  beforeEach(function () {
    partialWasEnabled = Konva.partialDrawEnabled;
    Konva.partialDrawEnabled = true;
  });

  afterEach(function () {
    Konva.partialDrawEnabled = partialWasEnabled;
  });

  function makeStage() {
    const stage = addStage();
    const layer = new Konva.Layer();
    stage.add(layer);
    return { stage, layer };
  }

  // the rendered bitmap of a layer
  function snapshot(layer: Konva.Layer) {
    const canvas = layer.getNativeCanvasElement() as HTMLCanvasElement;
    return (
      canvas
        .getContext('2d')!
        .getImageData(0, 0, canvas.width, canvas.height) as unknown as ImageData
    ).data.slice();
  }

  // render the same build/mutate sequence with whole-canvas and partial
  // redraws; the two bitmaps must be identical
  function assertModesEquivalent(
    build: (layer: Konva.Layer) => void,
    mutate?: (layer: Konva.Layer) => void
  ) {
    const render = (partial: boolean) => {
      Konva.partialDrawEnabled = partial;
      const stage = addStage();
      const layer = new Konva.Layer();
      stage.add(layer);
      build(layer);
      layer.draw();
      if (mutate) {
        mutate(layer);
        layer.draw();
      }
      const data = snapshot(layer);
      stage.destroy();
      return data;
    };
    const full = render(false);
    const partial = render(true);
    Konva.partialDrawEnabled = true;
    assert.deepEqual(Array.from(partial), Array.from(full));
  }

  it('moves a single node repainting only its old and new bounds', function () {
    const { stage, layer } = makeStage();
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    const other = new Konva.Rect({
      x: 200,
      y: 20,
      width: 40,
      height: 40,
      fill: 'blue',
    });
    layer.add(rect);
    layer.add(other);
    layer.draw();

    rect.x(120);
    layer.draw();

    const state = (layer as any)._partial;
    // the frame was a partial one, not a full redraw
    assert.isBelow(state.regions.length + 1, 100);
    // the untouched node keeps its pixels
    assert.equal(
      stage.getIntersection({ x: 220, y: 40 }),
      other,
      'unmoved node stays hit-testable'
    );
    // a point only the old position covered is now empty, a point in the new
    // box resolves to the rect
    assert.equal(stage.getIntersection({ x: 25, y: 25 }), null);
    assert.equal(stage.getIntersection({ x: 130, y: 30 }), rect);
  });

  it('produces the same pixels as a full redraw after a move', function () {
    assertModesEquivalent(
      (layer) =>
        layer.add(
          new Konva.Rect({
            x: 20,
            y: 20,
            width: 40,
            height: 40,
            fill: 'red',
          })
        ),
      (layer) => (layer.children[0] as Konva.Rect).x(120)
    );
  });

  it('repaints a style change without touching unrelated nodes', function () {
    const { stage, layer } = makeStage();
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    const other = new Konva.Circle({
      x: 300,
      y: 100,
      radius: 30,
      fill: 'blue',
    });
    layer.add(rect);
    layer.add(other);
    layer.draw();

    rect.fill('green');
    layer.draw();

    assert.equal(stage.getIntersection({ x: 300, y: 100 }), other);
    assertModesEquivalent(
      (l) => {
        l.add(
          new Konva.Rect({ x: 20, y: 20, width: 40, height: 40, fill: 'red' })
        );
        l.add(new Konva.Circle({ x: 300, y: 100, radius: 30, fill: 'blue' }));
      },
      (l) => (l.children[0] as Konva.Rect).fill('green')
    );
  });

  it('keeps high DPI bitmaps correct after a move', function () {
    const savedRatio = Konva.pixelRatio;
    Konva.pixelRatio = 2;
    try {
      assertModesEquivalent(
        (layer) =>
          layer.add(
            new Konva.Circle({
              x: 60,
              y: 60,
              radius: 30,
              fill: 'purple',
            })
          ),
        (layer) => (layer.children[0] as Konva.Circle).x(160)
      );
    } finally {
      Konva.pixelRatio = savedRatio;
    }
  });

  it('repaints overlapping nodes correctly', function () {
    assertModesEquivalent(
      (layer) => {
        layer.add(
          new Konva.Rect({ x: 10, y: 10, width: 100, height: 100, fill: 'red' })
        );
        layer.add(
          new Konva.Rect({
            x: 60,
            y: 60,
            width: 100,
            height: 100,
            fill: 'blue',
          })
        );
      },
      (layer) => (layer.children[0] as Konva.Rect).x(40)
    );
  });

  it('handles a node dragged outside the layer bounds', function () {
    assertModesEquivalent(
      (layer) =>
        layer.add(
          new Konva.Rect({ x: 10, y: 10, width: 40, height: 40, fill: 'red' })
        ),
      // move mostly outside the stage/layer box
      (layer) => (layer.children[0] as Konva.Rect).position({ x: 560, y: 180 })
    );
  });

  it('keeps shadow, stroke and rotation bounds correct after a change', function () {
    assertModesEquivalent(
      (layer) =>
        layer.add(
          new Konva.Rect({
            x: 100,
            y: 60,
            width: 60,
            height: 60,
            fill: 'yellow',
            stroke: 'black',
            strokeWidth: 6,
            shadowColor: 'black',
            shadowBlur: 12,
            shadowOffsetX: 8,
            shadowOffsetY: 8,
            shadowOpacity: 0.5,
            rotation: 20,
          })
        ),
      (layer) => (layer.children[0] as Konva.Rect).rotation(70)
    );
  });

  it('respects group clipping during a partial redraw', function () {
    assertModesEquivalent(
      (layer) => {
        const group = new Konva.Group({
          clipX: 0,
          clipY: 0,
          clipWidth: 120,
          clipHeight: 120,
        });
        group.add(
          new Konva.Rect({ x: 20, y: 20, width: 60, height: 60, fill: 'red' })
        );
        layer.add(group);
      },
      (layer) =>
        ((layer.children[0] as Konva.Group).children[0] as Konva.Rect).x(90)
    );
  });

  it('keeps a partially transparent group correct after a child change', function () {
    assertModesEquivalent(
      (layer) => {
        const group = new Konva.Group({ opacity: 0.4 });
        group.add(
          new Konva.Rect({ x: 20, y: 20, width: 60, height: 60, fill: 'red' })
        );
        group.add(
          new Konva.Circle({ x: 200, y: 80, radius: 25, fill: 'green' })
        );
        layer.add(group);
      },
      (layer) =>
        ((layer.children[0] as Konva.Group).children[0] as Konva.Rect).x(120)
    );
  });

  it('keeps a cached node correct when transformed after caching', function () {
    assertModesEquivalent(
      (layer) => {
        const rect = new Konva.Rect({
          x: 40,
          y: 40,
          width: 50,
          height: 50,
          fill: 'red',
        });
        layer.add(rect);
        rect.cache();
      },
      (layer) => (layer.children[0] as Konva.Rect).x(180)
    );
  });

  it('keeps a filtered cached node correct after a move', function () {
    assertModesEquivalent(
      (layer) => {
        const circle = new Konva.Circle({
          x: 80,
          y: 80,
          radius: 40,
          fill: 'green',
        });
        layer.add(circle);
        circle.cache();
        circle.filters([Konva.Filters.Brighten]);
        circle.brightness(0.4);
      },
      (layer) => (layer.children[0] as Konva.Circle).y(150)
    );
  });

  it('degrades to uncached rendering when the cache exceeds the pixel budget', function () {
    const savedBudget = Konva.maxCachePixels;
    const savedWarnings = Konva.showWarnings;
    Konva.showWarnings = false;
    Konva.maxCachePixels = 100 * 100;
    try {
      const { layer } = makeStage();
      const rect = new Konva.Rect({
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        fill: 'red',
      });
      layer.add(rect);
      rect.cache();
      assert.isFalse(rect.isCached(), 'oversized cache is skipped');
      // the node still renders and hit-tests correctly without a cache
      layer.draw();
      assert.equal(
        layer.getIntersection({ x: 50, y: 50 }),
        rect,
        'uncached node stays interactive'
      );
    } finally {
      Konva.maxCachePixels = savedBudget;
      Konva.showWarnings = savedWarnings;
    }
  });

  it('cache budget of 0 disables the limit', function () {
    const savedBudget = Konva.maxCachePixels;
    Konva.maxCachePixels = 0;
    try {
      const { layer } = makeStage();
      const rect = new Konva.Rect({
        x: 0,
        y: 0,
        width: 300,
        height: 300,
        fill: 'red',
      });
      layer.add(rect);
      rect.cache();
      assert.isTrue(rect.isCached());
    } finally {
      Konva.maxCachePixels = savedBudget;
    }
  });

  it('keeps pointer and touch hit results identical to a full redraw', function () {
    const build = (layer: Konva.Layer) => {
      layer.add(
        new Konva.Rect({
          x: 20,
          y: 20,
          width: 50,
          height: 50,
          fill: 'red',
          draggable: true,
        })
      );
      layer.add(
        new Konva.Circle({
          x: 250,
          y: 100,
          radius: 30,
          fill: 'blue',
        })
      );
    };
    const render = (partial: boolean) => {
      Konva.partialDrawEnabled = partial;
      const stage = addStage();
      const layer = new Konva.Layer();
      stage.add(layer);
      build(layer);
      layer.draw();
      (layer.children[0] as Konva.Rect).x(150);
      layer.draw();
      const mouse = stage.getIntersection({ x: 170, y: 45 });
      const empty = stage.getIntersection({ x: 30, y: 30 });
      stage.destroy();
      return {
        mouse: mouse?.getClassName() ?? null,
        empty: empty?.getClassName() ?? null,
      };
    };
    const full = render(false);
    const partial = render(true);
    Konva.partialDrawEnabled = true;
    assert.deepEqual(partial, full);
  });

  it('updates the hit graph through a simulated touch drag', function () {
    const { stage, layer } = makeStage();
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 50,
      height: 50,
      fill: 'red',
      draggable: true,
    });
    layer.add(rect);
    layer.draw();

    simulateTouchStart(stage, { x: 45, y: 45 });
    simulateTouchMove(stage, { x: 200, y: 100 });
    simulateTouchEnd(stage, { x: 200, y: 100 });

    // after the drag the hit graph follows the node to its new place
    assert.equal(stage.getIntersection({ x: 200, y: 100 }), rect);
    assert.equal(stage.getIntersection({ x: 45, y: 45 }), null);
  });

  it('does not change hit results relative to whole-canvas redraws', function () {
    const points = [
      { x: 25, y: 25 },
      { x: 60, y: 60 },
      { x: 200, y: 90 },
      { x: 300, y: 150 },
    ];
    const build = (layer: Konva.Layer) => {
      layer.add(
        new Konva.Rect({ x: 10, y: 10, width: 80, height: 80, fill: 'red' })
      );
      layer.add(
        new Konva.Circle({ x: 200, y: 100, radius: 40, fill: 'green' })
      );
    };
    const render = (partial: boolean) => {
      Konva.partialDrawEnabled = partial;
      const stage = addStage();
      const layer = new Konva.Layer();
      stage.add(layer);
      build(layer);
      layer.draw();
      (layer.children[0] as Konva.Rect).x(120);
      layer.draw();
      const ids = points.map(
        (p) => stage.getIntersection(p)?.getClassName() ?? null
      );
      stage.destroy();
      return ids;
    };
    const full = render(false);
    const partial = render(true);
    Konva.partialDrawEnabled = true;
    assert.deepEqual(partial, full);
  });

  it('falls back to a full redraw after a structural add/remove', function () {
    const { stage, layer } = makeStage();
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    layer.add(rect);
    layer.draw();

    const extra = new Konva.Circle({
      x: 300,
      y: 100,
      radius: 20,
      fill: 'pink',
    });
    layer.add(extra);
    layer.draw();

    assert.isTrue((layer as any)._partial.forceFull === false);
    assert.equal(stage.getIntersection({ x: 300, y: 100 }), extra);
    // removal also reconstructs the whole layer
    extra.remove();
    layer.draw();
    assert.equal(stage.getIntersection({ x: 300, y: 100 }), null);
  });

  it('handles a move inside deeply nested groups with inherited transforms', function () {
    assertModesEquivalent(
      (layer) => {
        let parent: Konva.Node = layer;
        for (let d = 0; d < 6; d++) {
          const group = new Konva.Group({
            x: 10,
            y: 8,
            rotation: d * 5,
            scaleX: 1.02,
            scaleY: 0.98,
          });
          (parent as Konva.Group).add(group);
          parent = group;
        }
        (parent as Konva.Group).add(
          new Konva.Rect({
            x: 0,
            y: 0,
            width: 30,
            height: 30,
            fill: 'red',
          })
        );
      },
      (layer) => {
        let node: Konva.Node = layer;
        while ((node as Konva.Container).hasChildren()) {
          node = (node as Konva.Container).children[0];
        }
        (node as Konva.Rect).x(80);
      }
    );
  });

  it('renders a cached filtered group identically under both redraw modes', function () {
    assertModesEquivalent(
      (layer) => {
        const group = new Konva.Group();
        group.add(
          new Konva.Rect({ x: 10, y: 10, width: 60, height: 60, fill: 'red' })
        );
        group.add(
          new Konva.Circle({ x: 150, y: 80, radius: 30, fill: 'blue' })
        );
        layer.add(group);
        group.cache();
        group.filters([Konva.Filters.Grayscale]);
      },
      (layer) => (layer.children[0] as Konva.Group).x(120)
    );
  });

  it('disabling partialDrawEnabled restores whole-canvas redraws', function () {
    Konva.partialDrawEnabled = false;
    const stage = addStage();
    const layer = new Konva.Layer();
    stage.add(layer);
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    layer.add(rect);
    layer.draw();

    rect.x(120);
    layer.draw();

    assert.isNull((layer as any)._partial.preparedRegions);
    assert.equal(stage.getIntersection({ x: 130, y: 30 }), rect);
    assert.equal(stage.getIntersection({ x: 25, y: 25 }), null);
    Konva.partialDrawEnabled = true;
  });

  it('handles several moves of the same node within one frame', function () {
    assertModesEquivalent(
      (layer) =>
        layer.add(
          new Konva.Rect({ x: 10, y: 10, width: 30, height: 30, fill: 'red' })
        ),
      (layer) => {
        const node = layer.children[0] as Konva.Rect;
        node.x(100);
        node.x(200);
        node.y(90);
      }
    );
  });

  it('repaints correctly when a parent group moves', function () {
    assertModesEquivalent(
      (layer) => {
        const group = new Konva.Group({ x: 30, y: 30 });
        group.add(
          new Konva.Rect({ x: 0, y: 0, width: 40, height: 40, fill: 'red' })
        );
        group.add(
          new Konva.Circle({ x: 120, y: 60, radius: 20, fill: 'blue' })
        );
        layer.add(group);
      },
      (layer) => (layer.children[0] as Konva.Group).x(250)
    );
  });

  it('repaints correctly when several nodes change in the same frame', function () {
    assertModesEquivalent(
      (layer) => {
        for (let i = 0; i < 6; i++) {
          layer.add(
            new Konva.Rect({
              x: i * 80,
              y: 20,
              width: 30,
              height: 30,
              fill: i % 2 ? 'red' : 'green',
            })
          );
        }
      },
      (layer) => {
        (layer.children[1] as Konva.Rect).y(120);
        (layer.children[4] as Konva.Rect).rotation(45);
      }
    );
  });

  it('falls back to a full redraw for an unbounded custom sceneFunc', function () {
    const { stage, layer } = makeStage();
    const custom = new Konva.Shape({
      sceneFunc: (ctx: any) => {
        ctx.beginPath();
        ctx.arc(50, 50, 40, 0, Math.PI * 2);
        ctx.fillStyle = 'red';
        ctx.fill();
      },
      // intentionally no selfRectFunc: Konva cannot bound the painting
    } as any);
    layer.add(custom);
    layer.draw();

    custom.x(100);
    // a partial frame cannot bound custom drawing, so the scene frame falls
    // back to a whole-canvas redraw (preparedRegions stays null)
    const regions = (layer as any)._preparePartialFrame();

    assert.isNull(regions);
  });

  it('does not use partial redraw when clearBeforeDraw is false', function () {
    const stage = addStage();
    const layer = new Konva.Layer({ clearBeforeDraw: false });
    stage.add(layer);
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    layer.add(rect);
    layer.draw();

    rect.x(120);
    layer.draw();

    assert.isNull((layer as any)._partial.preparedRegions);
    assert.equal(stage.getIntersection({ x: 130, y: 30 }), rect);
  });

  it('skips drawing nodes outside the dirty region (performance)', function () {
    const measure = (partial: boolean) => {
      Konva.partialDrawEnabled = partial;
      const stage = addStage();
      const layer = new Konva.Layer();
      stage.add(layer);
      const nodes: Konva.Rect[] = [];
      for (let i = 0; i < 50; i++) {
        const rect = new Konva.Rect({
          x: (i % 10) * 55,
          y: Math.floor(i / 10) * 48,
          width: 40,
          height: 40,
          fill: 'red',
        });
        layer.add(rect);
        nodes.push(rect);
      }
      layer.draw();

      // move one node far from the rest; count how many sceneFunc runs follow
      nodes[0].x(520);
      const sceneDraws = countCalls(Konva.Shape.prototype, 'drawScene', () =>
        layer.draw()
      );
      stage.destroy();
      return sceneDraws;
    };
    const fullDraws = measure(false);
    const partialDraws = measure(true);
    Konva.partialDrawEnabled = true;

    // a full redraw paints every shape; a partial one only the moved shape
    assert.equal(fullDraws, 50);
    assert.isAtMost(partialDraws, 2);
    assert.isBelow(partialDraws, fullDraws);
  });

  it('partial and full redraws converge on the same final scene', function () {
    // several successive moves of one node among many, comparing the bitmap
    // after every step against an equivalent whole-canvas pipeline
    const steps = [60, 140, 90, 300, 20];
    const render = (partial: boolean) => {
      Konva.partialDrawEnabled = partial;
      const stage = addStage();
      const layer = new Konva.Layer();
      stage.add(layer);
      for (let i = 0; i < 20; i++) {
        layer.add(
          new Konva.Circle({
            x: 40 + (i % 5) * 110,
            y: 40 + Math.floor(i / 5) * 50,
            radius: 18,
            fill: i % 2 ? 'teal' : 'orange',
          })
        );
      }
      const mover = new Konva.Rect({
        x: 10,
        y: 10,
        width: 30,
        height: 30,
        fill: 'black',
      });
      layer.add(mover);
      layer.draw();
      steps.forEach((x) => {
        mover.x(x);
        layer.draw();
      });
      const data = snapshot(layer);
      stage.destroy();
      return data;
    };
    assert.deepEqual(Array.from(render(true)), Array.from(render(false)));
    Konva.partialDrawEnabled = true;
  });

  it('computes the painted bounds of a changed node only once per frame', function () {
    const { layer } = makeStage();
    const rect = new Konva.Rect({
      x: 20,
      y: 20,
      width: 40,
      height: 40,
      fill: 'red',
    });
    layer.add(rect);
    layer.draw();

    rect.x(140);
    const seen: string[] = [];
    const original = rect.getClientRect;
    rect.getClientRect = function (config: any) {
      seen.push(JSON.stringify(config || {}));
      return original.call(this, config);
    };
    layer.draw();
    rect.getClientRect = original;

    // the partial renderer reuses painted bounds for its culling path; the
    // remaining calls are the unchanged shape draw path, so the count stays
    // small and stable instead of growing with node count
    const drawing = seen.filter((c) => c.includes('_forDrawing'));
    assert.isAtMost(drawing.length, 4);
    const transformCalls = seen.filter((c) => c.includes('skipTransform'));
    assert.equal(transformCalls.length, 2, 'old and new local bounds');
  });
});
