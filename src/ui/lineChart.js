const TEXT = '#e6e9ec';
const MUTED = '#9aa4ad';
const GRID = 'rgba(255, 255, 255, 0.07)';

/**
 * Small line chart over generations: one y-axis, 2 px lines, a legend (for
 * two or more series) plus end labels, optional vertical markers (course
 * changes) and a crosshair tooltip on hover.
 *
 *   new LineChart(canvas, legend, { series: [{ key, label, color }], format, yMax })
 *   chart.draw(points, markers)   points: [{ generation, ...values }]
 *                                 markers: [{ generation, label }]
 */
export class LineChart {
  constructor(canvas, legend, { series, format = (v) => v.toFixed(0), yMax = null, empty = 'No data yet' }) {
    this.canvas = canvas;
    this.series = series;
    this.format = format;
    this.yMax = yMax;
    this.empty = empty;
    this.points = [];
    this.markers = [];
    this.hoverX = null;
    if (legend) {
      legend.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    }
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.hoverX = ((e.clientX - rect.left) / rect.width) * canvas.width;
      this.draw(this.points, this.markers);
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.draw(this.points, this.markers);
    });
  }

  draw(points, markers = []) {
    this.points = points;
    this.markers = markers;
    const { canvas, series } = this;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const pad = { left: 38, right: 40, top: 10, bottom: 18 };
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-monospace, Consolas, monospace';

    if (points.length === 0) {
      ctx.fillStyle = MUTED;
      ctx.fillText(this.empty, pad.left, h / 2);
      return;
    }

    const values = points.flatMap((p) => series.map((s) => p[s.key]));
    const maxY = this.yMax ?? niceMax(Math.max(...values, 1));
    const minY = this.yMax ? 0 : Math.min(0, niceMin(Math.min(...values)));
    const n = points.length;
    const g0 = points[0].generation;
    const g1 = points[n - 1].generation;
    const px = (g) => pad.left + (g1 === g0 ? (w - pad.left - pad.right) / 2 : ((w - pad.left - pad.right) * (g - g0)) / (g1 - g0));
    const py = (v) => h - pad.bottom - ((h - pad.top - pad.bottom) * (v - minY)) / (maxY - minY);

    // Recessive grid, zero line, axis labels.
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (const v of [minY, (minY + maxY) / 2, maxY]) {
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(pad.left, py(v));
      ctx.lineTo(w - pad.right, py(v));
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(this.format(v), pad.left - 4, py(v) + 3);
    }
    if (minY < 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.beginPath();
      ctx.moveTo(pad.left, py(0));
      ctx.lineTo(w - pad.right, py(0));
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = MUTED;
    ctx.fillText(`gen ${g0}`, px(g0), h - 4);
    if (g1 !== g0) ctx.fillText(`gen ${g1}`, px(g1), h - 4);

    // Markers (e.g. course changes) as dotted verticals with a label.
    ctx.textAlign = 'left';
    for (const marker of markers) {
      if (marker.generation <= g0 || marker.generation > g1) continue;
      const x = px(marker.generation - 0.5);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = MUTED;
      ctx.fillText(marker.label, x + 3, pad.top + 7);
    }

    for (const s of series) {
      ctx.beginPath();
      points.forEach((p, i) => (i === 0 ? ctx.moveTo(px(p.generation), py(p[s.key])) : ctx.lineTo(px(p.generation), py(p[s.key]))));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      if (n === 1) dot(ctx, px(g0), py(points[0][s.key]), s.color);
    }

    // End labels in text colours, nudged apart when they collide.
    const last = points[n - 1];
    const ends = series.map((s) => ({ s, y: py(last[s.key]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 11) ends[i].y = ends[i - 1].y + 11;
    ctx.textAlign = 'left';
    ends.forEach(({ s, y }, i) => {
      ctx.fillStyle = i === 0 ? TEXT : MUTED;
      ctx.fillText(this.format(last[s.key]), w - pad.right + 4, y + 3);
    });

    // Hover: crosshair + tooltip for the nearest generation.
    if (this.hoverX !== null && this.hoverX >= pad.left - 6 && this.hoverX <= w - pad.right + 6) {
      let nearest = points[0];
      for (const p of points) if (Math.abs(px(p.generation) - this.hoverX) < Math.abs(px(nearest.generation) - this.hoverX)) nearest = p;
      const x = px(nearest.generation);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, h - pad.bottom);
      ctx.stroke();
      for (const s of series) dot(ctx, x, py(nearest[s.key]), s.color);
      const lines = [`gen ${nearest.generation}${nearest.course ? ` · ${nearest.course}` : ''}`, ...series.map((s) => `${s.label} ${this.format(nearest[s.key])}`)];
      const boxW = 128;
      const boxH = 10 + lines.length * 12;
      const boxX = x + boxW + 8 > w ? x - boxW - 8 : x + 8;
      ctx.fillStyle = 'rgba(11, 15, 20, 0.94)';
      ctx.fillRect(boxX, pad.top, boxW, boxH);
      lines.forEach((text, k) => {
        ctx.fillStyle = k === 0 ? MUTED : TEXT;
        ctx.fillText(text, boxX + 6, pad.top + 13 + k * 12);
      });
    }
    ctx.textAlign = 'start';
  }
}

function dot(ctx, x, y, color) {
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#12161b';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function niceMax(v) {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

function niceMin(v) {
  return v >= 0 ? 0 : -niceMax(-v);
}
