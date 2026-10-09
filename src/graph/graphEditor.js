import { MouseButton } from '../engine/input.js';
import { snap } from '../math/utils.js';
import { Point } from '../primitives/point.js';
import { Segment } from '../primitives/segment.js';

export const EditorMode = { GRAPH: 'graph', ROAD: 'road', DRIVE: 'drive', TRAIN: 'train' };

export const LANE_LIMITS = { min: 1, max: 6 };

/**
 * Mouse/keyboard editing of the road graph.
 *
 * Graph mode — build the network:
 *   left click empty space    add a node (connected to the selected one)
 *   left click a road         split it and insert a node (hold Shift to skip)
 *   left click a node         select it / connect the selection to it
 *   left drag a node          move it
 *   right click               deselect, or delete the hovered node / edge
 *
 * Drive mode — the editor is idle while the keyboard drives the car.
 *
 * Road mode — configure edges:
 *   left click a road         select it
 *   + / -                     add / remove a lane
 *   O                         toggle one-way
 *   R                         reverse direction
 */
export class GraphEditor {
  constructor(graph, { camera, input, laneWidth = 22, gridSize = 25 }) {
    this.graph = graph;
    this.camera = camera;
    this.input = input;
    this.laneWidth = laneWidth;
    this.gridSize = gridSize;

    this.mode = EditorMode.GRAPH;
    this.snapToGrid = false;
    this.defaultAttributes = { lanes: 2, oneWay: false };

    this.mouse = new Point(0, 0);
    this.hovered = null;
    this.hoveredSegment = null;
    this.selected = null;
    this.selectedSegment = null;
    this.selectedJunction = null; // node (Phase 6: junction controls in Roads mode)
    this.dragging = false;
  }

  setMode(mode) {
    this.mode = mode;
    this.selected = null;
    this.selectedSegment = null;
    this.selectedJunction = null; // node (Phase 6: junction controls in Roads mode)
    this.dragging = false;
  }

  snapPoint(p) {
    return this.snapToGrid ? new Point(snap(p.x, this.gridSize), snap(p.y, this.gridSize)) : p;
  }

  /** `pointerBlocked` is true while the camera is being panned. */
  update(pointerBlocked = false) {
    const { input, camera, graph } = this;
    this.#dropStaleReferences();

    this.mouse = camera.screenToWorld(input.mouse.position);
    if (this.mode === EditorMode.DRIVE || this.mode === EditorMode.TRAIN) {
      // Driving or training: the mouse doesn't edit anything.
      this.hovered = null;
      this.hoveredSegment = null;
      return;
    }
    const pickRadius = 12 / camera.zoom;
    this.hovered = graph.getNearestPoint(this.mouse, pickRadius);
    const segmentRadius =
      this.mode === EditorMode.ROAD ? Math.max(pickRadius, this.laneWidth) : 8 / camera.zoom;
    this.hoveredSegment = this.hovered ? null : graph.getNearestSegment(this.mouse, segmentRadius);

    if (input.wasPressed('Escape')) {
      this.selected = null;
      this.selectedSegment = null;
    }

    if (pointerBlocked || !input.mouse.inside) {
      if (!input.isMouseDown(MouseButton.LEFT)) this.dragging = false;
      if (pointerBlocked) return;
    }

    if (this.mode === EditorMode.GRAPH) this.#updateGraphMode();
    else this.#updateRoadMode();
  }

  #updateGraphMode() {
    const { input, graph } = this;

    if (this.dragging) {
      if (input.isMouseDown(MouseButton.LEFT) && this.selected) {
        const p = this.snapPoint(this.mouse);
        graph.movePoint(this.selected, p.x, p.y);
      } else {
        this.dragging = false;
      }
    }

    if (input.wasMousePressed(MouseButton.LEFT) && input.mouse.inside) {
      if (this.hovered) {
        this.#connectSelectionTo(this.hovered);
        this.selected = this.hovered;
        this.dragging = true;
      } else {
        let node;
        if (this.hoveredSegment && !input.shift) {
          node = graph.splitSegment(this.hoveredSegment, this.mouse);
        } else {
          const p = this.snapPoint(this.mouse);
          node = graph.containsPoint(p) ?? graph.addPoint(p.clone());
        }
        this.#connectSelectionTo(node);
        this.selected = node;
      }
    }

    if (input.wasMousePressed(MouseButton.RIGHT)) {
      if (this.selected) {
        this.selected = null;
      } else if (this.hovered) {
        graph.removePoint(this.hovered);
        this.hovered = null;
      } else if (this.hoveredSegment) {
        graph.removeSegment(this.hoveredSegment);
        this.hoveredSegment = null;
      }
    }

    if (input.wasPressed('Delete') || input.wasPressed('Backspace')) {
      if (this.selected) {
        graph.removePoint(this.selected);
        this.selected = null;
      } else if (this.hoveredSegment) {
        graph.removeSegment(this.hoveredSegment);
      }
    }
  }

  #updateRoadMode() {
    const { input } = this;

    if (input.wasMousePressed(MouseButton.LEFT) && input.mouse.inside) {
      // A junction node (3+ roads) selects the junction, otherwise a road.
      const junction = this.hovered && this.graph.degree(this.hovered) >= 3 ? this.hovered : null;
      this.selectedJunction = junction;
      this.selectedSegment = junction ? null : this.hoveredSegment;
    }
    if (input.wasMousePressed(MouseButton.RIGHT)) {
      this.selectedSegment = null;
      this.selectedJunction = null;
    }

    const seg = this.selectedSegment;
    if (!seg) return;
    if (input.wasPressed('Equal') || input.wasPressed('NumpadAdd')) this.setLanes(seg, seg.lanes + 1);
    if (input.wasPressed('Minus') || input.wasPressed('NumpadSubtract')) this.setLanes(seg, seg.lanes - 1);
    if (input.wasPressed('KeyO')) this.setOneWay(seg, !seg.oneWay);
    if (input.wasPressed('KeyR')) this.reverse(seg);
    if (input.wasPressed('Delete') || input.wasPressed('Backspace')) {
      this.graph.removeSegment(seg);
      this.selectedSegment = null;
    }
  }

  // ---- road attribute operations (also used by the side panel) ------------

  setLanes(seg, lanes) {
    const min = seg.oneWay ? LANE_LIMITS.min : 2;
    const next = Math.min(LANE_LIMITS.max, Math.max(min, lanes));
    if (next === seg.lanes) return;
    seg.lanes = next;
    this.#rememberAttributes(seg);
  }

  setType(seg, type) {
    seg.type = type;
    this.graph.touch();
  }

  /** km/h, or null for the road type's default. */
  setSpeedLimit(seg, kmh) {
    seg.speedLimit = kmh || null;
    this.graph.touch();
  }

  setCrossing(seg, crossing) {
    seg.crossing = crossing;
    this.graph.touch();
  }

  setOneWay(seg, oneWay) {
    seg.oneWay = oneWay;
    if (!oneWay && seg.lanes < 2) seg.lanes = 2;
    this.#rememberAttributes(seg);
  }

  reverse(seg) {
    seg.reverse();
    this.graph.touch();
  }

  #rememberAttributes(seg) {
    this.defaultAttributes = seg.attributes;
    this.graph.touch();
  }

  #connectSelectionTo(node) {
    if (this.selected && this.selected !== node) {
      this.graph.tryAddSegment(new Segment(this.selected, node, { ...this.defaultAttributes }));
    }
  }

  #dropStaleReferences() {
    const { graph } = this;
    if (this.selected && !graph.points.includes(this.selected)) this.selected = null;
    if (this.selectedJunction && (!graph.points.includes(this.selectedJunction) || graph.degree(this.selectedJunction) < 3)) {
      this.selectedJunction = null;
    }
    if (this.selectedSegment && !graph.segments.includes(this.selectedSegment)) {
      this.selectedSegment = null;
    }
  }

  // ---- drawing ------------------------------------------------------------

  draw(ctx, { showGraph = true } = {}) {
    const px = 1 / this.camera.zoom;
    if (this.mode === EditorMode.DRIVE || this.mode === EditorMode.TRAIN) return;
    if (this.mode === EditorMode.GRAPH) this.#drawGraphMode(ctx, px, showGraph);
    else this.#drawRoadMode(ctx, px, showGraph);
  }

  #drawGraphMode(ctx, px, showGraph) {
    const { graph } = this;
    if (showGraph) {
      for (const seg of graph.segments) {
        seg.draw(ctx, { width: 1.5 * px, color: 'rgba(120, 200, 255, 0.55)' });
      }
    }

    if (this.hoveredSegment && !this.hovered) {
      this.hoveredSegment.draw(ctx, { width: 5 * px, color: 'rgba(255, 213, 74, 0.8)', cap: 'round' });
    }

    if (this.selected) {
      const target = this.hovered ?? this.snapPoint(this.mouse);
      new Segment(this.selected, target).draw(ctx, {
        width: 2 * px,
        color: 'rgba(255, 213, 74, 0.9)',
        dash: [8 * px, 6 * px],
      });
    }

    if (showGraph) {
      for (const p of graph.points) p.draw(ctx, { size: 12 * px, color: '#78c8ff' });
    }
    if (this.hovered) this.hovered.draw(ctx, { size: 16 * px, color: '#78c8ff', outline: '#ffffff' });
    if (this.selected) this.selected.draw(ctx, { size: 16 * px, color: '#78c8ff', fill: '#ffd54a' });

    if (this.snapToGrid && !this.hovered && this.input.mouse.inside) {
      const s = this.snapPoint(this.mouse);
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 213, 74, 0.9)';
      ctx.lineWidth = 1.5 * px;
      ctx.moveTo(s.x - 6 * px, s.y);
      ctx.lineTo(s.x + 6 * px, s.y);
      ctx.moveTo(s.x, s.y - 6 * px);
      ctx.lineTo(s.x, s.y + 6 * px);
      ctx.stroke();
    }
  }

  #drawRoadMode(ctx, px, showGraph) {
    if (showGraph) {
      for (const seg of this.graph.segments) {
        seg.draw(ctx, { width: 1.5 * px, color: 'rgba(120, 200, 255, 0.5)' });
      }
    }
    const highlight = (seg, color) => {
      seg.draw(ctx, { width: seg.lanes * this.laneWidth + 6, color, cap: 'round' });
    };
    if (this.hoveredSegment && this.hoveredSegment !== this.selectedSegment) {
      highlight(this.hoveredSegment, 'rgba(255, 213, 74, 0.18)');
    }
    if (this.selectedJunction) {
      this.selectedJunction.draw(ctx, { size: 22 * px, color: 'rgba(255, 213, 74, 0.35)', outline: '#ffd54a' });
    } else if (this.hovered && this.graph.degree(this.hovered) >= 3) {
      this.hovered.draw(ctx, { size: 18 * px, color: 'rgba(255, 213, 74, 0.2)', outline: '#ffffff' });
    }
    if (this.selectedSegment) {
      highlight(this.selectedSegment, 'rgba(255, 213, 74, 0.32)');
      const { p1, p2 } = this.selectedSegment;
      p1.draw(ctx, { size: 12 * px, color: '#7bd88f' });
      p2.draw(ctx, { size: 12 * px, color: '#ff7b7b' });
    }
  }
}
