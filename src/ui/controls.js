import { EditorMode } from '../graph/graphEditor.js';

/**
 * Binds the HTML toolbar / road panel to the app. `sync()` runs every frame
 * but only touches the DOM when the displayed values actually change.
 */
export class Controls {
  constructor({ editor, network, flags, actions }) {
    this.editor = editor;
    this.network = network;
    this.flags = flags; // { name: { get(), set(value) } }
    this.actions = actions;
    this.lastSignature = '';

    this.modeButtons = document.querySelectorAll('[data-mode]');
    this.toggleButtons = document.querySelectorAll('[data-toggle]');
    this.roadPanel = document.getElementById('road-panel');
    this.helpPanel = document.getElementById('help');
    this.status = document.getElementById('status');
    this.importInput = document.getElementById('import-file');

    this.#bind();
  }

  #bind() {
    for (const btn of this.modeButtons) {
      btn.addEventListener('click', () => this.editor.setMode(btn.dataset.mode));
    }
    for (const btn of this.toggleButtons) {
      btn.addEventListener('click', () => {
        const flag = this.flags[btn.dataset.toggle];
        flag.set(!flag.get());
      });
    }

    document.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => this.#runAction(btn));
    });

    this.importInput.addEventListener('change', () => {
      const [file] = this.importInput.files;
      if (file) this.actions.import(file);
      this.importInput.value = '';
    });

    this.roadPanel.addEventListener('click', (e) => {
      const seg = this.editor.selectedSegment;
      const op = e.target.closest('[data-road]')?.dataset.road;
      if (!seg || !op) return;
      if (op === 'lanes+') this.editor.setLanes(seg, seg.lanes + 1);
      if (op === 'lanes-') this.editor.setLanes(seg, seg.lanes - 1);
      if (op === 'reverse') this.editor.reverse(seg);
      if (op === 'delete') {
        this.editor.graph.removeSegment(seg);
        this.editor.selectedSegment = null;
      }
    });
    this.roadPanel.querySelector('[data-road="oneWay"]').addEventListener('change', (e) => {
      const seg = this.editor.selectedSegment;
      if (seg) this.editor.setOneWay(seg, e.target.checked);
    });

    // Buttons shouldn't keep keyboard focus, otherwise Space would "click" them.
    document.querySelectorAll('button').forEach((b) => b.addEventListener('mouseup', () => b.blur()));
  }

  #runAction(btn) {
    const name = btn.dataset.action;
    if (name === 'import') return this.importInput.click();
    if (name === 'help') return this.toggleHelp();
    if (name === 'clear' || name === 'demo') {
      // Destructive: require a second click instead of a blocking confirm().
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.dataset.label = btn.textContent;
        btn.textContent = 'Sure?';
        setTimeout(() => this.#resetConfirm(btn), 2500);
        return;
      }
      this.#resetConfirm(btn);
    }
    this.actions[name]?.();
  }

  #resetConfirm(btn) {
    if (!btn.classList.contains('confirm')) return;
    btn.classList.remove('confirm');
    btn.textContent = btn.dataset.label;
  }

  toggleHelp() {
    this.helpPanel.hidden = !this.helpPanel.hidden;
  }

  sync() {
    const { editor } = this;
    const seg = editor.mode === EditorMode.ROAD ? editor.selectedSegment : null;
    const road = seg && this.network.roads.find((r) => r.segment === seg);
    const flagValues = Object.entries(this.flags).map(([k, f]) => `${k}:${f.get()}`);
    const signature = [
      editor.mode,
      flagValues.join(','),
      road ? `${road.laneCount}/${road.oneWay}/${Math.round(seg.length())}/${road.forwardLanes}` : '-',
      editor.selected ? 'sel' : '',
      editor.hovered ? 'hov' : '',
      editor.hoveredSegment ? 'hseg' : '',
      editor.dragging ? 'drag' : '',
    ].join('|');
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    for (const btn of this.modeButtons) btn.classList.toggle('active', btn.dataset.mode === editor.mode);
    for (const btn of this.toggleButtons) btn.classList.toggle('active', !!this.flags[btn.dataset.toggle].get());

    this.roadPanel.hidden = !road;
    if (road) {
      const set = (field, value) => (this.roadPanel.querySelector(`[data-field="${field}"]`).textContent = value);
      set('length', `${Math.round(seg.length())} u`);
      set('width', `${Math.round(road.width)} u`);
      set('forward', road.forwardLanes);
      set('backward', road.backwardLanes);
      set('lanes', road.laneCount);
      this.roadPanel.querySelector('[data-road="oneWay"]').checked = road.oneWay;
    }

    this.status.innerHTML = this.#statusText();
  }

  #statusText() {
    const e = this.editor;
    if (e.mode === EditorMode.DRIVE) {
      return '<b>Drive</b> · <kbd>↑</kbd><kbd>W</kbd> throttle · <kbd>↓</kbd><kbd>S</kbd> brake / reverse · <kbd>←</kbd><kbd>→</kbd> steer · <kbd>Space</kbd> handbrake · <kbd>R</kbd> reset car · <kbd>1</kbd> back to editing';
    }
    if (e.mode === EditorMode.ROAD) {
      return e.selectedSegment
        ? '<b>Roads</b> · <kbd>+</kbd>/<kbd>−</kbd> lanes · <kbd>O</kbd> one-way · <kbd>R</kbd> reverse · right click to deselect'
        : '<b>Roads</b> · click a road to edit its lanes and direction';
    }
    if (e.dragging) return '<b>Graph</b> · moving node — release to drop';
    if (e.selected) {
      return '<b>Graph</b> · click to add a connected node · click a node to link · right click / <kbd>Esc</kbd> to deselect';
    }
    if (e.hovered) return '<b>Graph</b> · click to select · drag to move · right click to delete';
    if (e.hoveredSegment) return '<b>Graph</b> · click to split this edge · right click to delete it';
    return '<b>Graph</b> · click to place a node · scroll to zoom · Space+drag to pan · <kbd>H</kbd> for help';
  }
}
