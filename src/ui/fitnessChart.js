const SERIES = [
  { key: 'best', label: 'Best', color: '#3987e5' },
  { key: 'average', label: 'Average', color: '#d95926' },
];
const TEXT = '#e6e9ec';
const MUTED = '#9aa4ad';
const GRID = 'rgba(255, 255, 255, 0.07)';

/**
 * Best and average fitness per generation: one axis (metres of road), 2 px
 * lines, a legend plus end labels, and a crosshair tooltip on hover.
 */
export class FitnessChart {
  constructor(canvas, legend) {
    this.canvas = canvas;
    this.history = [];
    this.hoverX = null;
    legend.innerHTML = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverX = ((e.clientX - rect.left) / rect.width) * canvas.width;
      this.draw(this.history);
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.draw(this.history);
    });
  }

  draw(history) {
    this.history = history;
    const { canvas } = this;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const pad = { left: 34, right: 44, top: 8, bottom: 18 };
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-monospace, Consolas, monospace';

    if (history.length === 0) {
      ctx.fillStyle = MUTED;
      ctx.fillText('Fitness appears after the first generation', pad.left, h / 2);
      return;
    }

    const maxY = niceMax(Math.max(...history.map((p) => p.best), 10));
    const n = history.length;
    const px = (i) => pad.left + (n === 1 ? (w - pad.left - pad.right) / 2 : ((w - pad.left - pad.right) * i) / (n - 1));
    const py = (v) => h - pad.bottom - ((h - pad.top - pad.bottom) * v) / maxY;

    // Recessive grid and axis labels.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    for (let k = 0; k <= 2; k++) {
      const v = (maxY * k) / 2;
      ctx.beginPath();
      ctx.moveTo(pad.left, py(v));
      ctx.lineTo(w - pad.right, py(v));
      ctx.stroke();
      ctx.fillText(`${v.toFixed(0)} m`, pad.left - 4, py(v) + 3);
    }
    ctx.textAlign = 'center';
    ctx.fillText(`gen ${history[0].generation}`, px(0), h - 4);
    if (n > 1) ctx.fillText(`gen ${history[n - 1].generation}`, px(n - 1), h - 4);

    for (const s of SERIES) {
      ctx.beginPath();
      history.forEach((p, i) => (i === 0 ? ctx.moveTo(px(i), py(p[s.key])) : ctx.lineTo(px(i), py(p[s.key]))));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (n === 1) {
        ctx.beginPath();
        ctx.arc(px(0), py(history[0][s.key]), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      }
    }

    // End labels (text colour, not series colour), nudged apart if they collide.
    const last = history[n - 1];
    const yBest = py(last.best);
    let yAvg = py(last.average);
    if (Math.abs(yAvg - yBest) < 11) yAvg = yBest + 11;
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(`${last.best.toFixed(0)}`, w - pad.right + 4, yBest + 3);
    ctx.fillStyle = MUTED;
    ctx.fillText(`${last.average.toFixed(0)}`, w - pad.right + 4, yAvg + 3);

    // Hover: crosshair + tooltip for the nearest generation.
    if (this.hoverX !== null && this.hoverX >= pad.left - 6 && this.hoverX <= w - pad.right + 6) {
      const i = n === 1 ? 0 : Math.round(((this.hoverX - pad.left) / (w - pad.left - pad.right)) * (n - 1));
      const p = history[Math.max(0, Math.min(n - 1, i))];
      const x = px(Math.max(0, Math.min(n - 1, i)));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      for (const s of SERIES) {
        ctx.beginPath();
        ctx.arc(x, py(p[s.key]), 4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#12161b';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      const lines = [`gen ${p.generation}`, `best ${p.best.toFixed(0)} m`, `avg ${p.average.toFixed(1)} m`];
      const boxW = 96;
      const boxX = x + boxW + 8 > w ? x - boxW - 8 : x + 8;
      ctx.fillStyle = 'rgba(11, 15, 20, 0.92)';
      ctx.fillRect(boxX, pad.top, boxW, 40);
      ctx.textAlign = 'left';
      lines.forEach((text, k) => {
        ctx.fillStyle = k === 0 ? MUTED : TEXT;
        ctx.fillText(text, boxX + 6, pad.top + 11 + k * 12);
      });
    }
    ctx.textAlign = 'start';
  }
}

function niceMax(v) {
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}
