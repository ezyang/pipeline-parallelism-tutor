// SVG export of a schedule — publication-style figure, standalone (no CSS deps).
import { cellStyle } from './palettes.js';
import * as E from './engine.js';

const CELL = 26, ROWH = 30, PAD = 6, HEAD = 64, AXIS = 18;

export function scheduleSVG(sim, { theme = 'microbatch', mode = 'light', title = '' } = {}) {
  const cfg = sim.cfg;
  const horizon = Math.max(...sim.frontier, 1);
  const W = HEAD + horizon * CELL + PAD * 2;
  const H = AXIS + cfg.P * ROWH + PAD * 2 + (title ? 20 : 0);
  const surface = mode === 'dark' ? '#1a1a19' : '#fcfcfb';
  const ink = mode === 'dark' ? '#ffffff' : '#0b0b0b';
  const muted = '#898781';
  const grid = mode === 'dark' ? '#2c2c2a' : '#e1e0d9';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const top = (title ? 20 : 0);

  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">`;
  out += `<rect width="${W}" height="${H}" fill="${surface}"/>`;
  if (title) out += `<text x="${PAD}" y="14" font-size="12" font-weight="600" fill="${ink}">${esc(title)}</text>`;

  // axis + gridlines
  for (let t = 0; t <= horizon; t++) {
    const x = HEAD + PAD + t * CELL;
    out += `<line x1="${x}" y1="${top + AXIS}" x2="${x}" y2="${top + AXIS + cfg.P * ROWH}" stroke="${grid}" stroke-width="1"/>`;
    if (t % 2 === 0 && t < horizon)
      out += `<text x="${x + 2}" y="${top + AXIS - 5}" font-size="8" fill="${muted}">${t}</text>`;
  }

  for (let r = 0; r < cfg.P; r++) {
    const y = top + AXIS + r * ROWH;
    out += `<text x="${PAD}" y="${y + ROWH / 2 + 3}" font-size="10" font-weight="600" fill="${ink}">rank ${r}</text>`;
    for (const item of sim.rows[r]) {
      const x = HEAD + PAD + item.start * CELL;
      const w = item.dur * CELL - 3;
      if (!item.id) {
        out += `<rect x="${x + 1.5}" y="${y + 4}" width="${CELL - 3}" height="${ROWH - 8}" rx="3" fill="none" stroke="${grid}" stroke-dasharray="3,2"/>`;
        continue;
      }
      const op = sim.byId.get(item.id);
      const st = cellStyle(theme, mode, op, cfg);
      out += `<rect x="${x + 1.5}" y="${y + 4}" width="${w}" height="${ROWH - 8}" rx="3" fill="${st.bg}" stroke="${st.border}" stroke-width="1.2"/>`;
      out += `<text x="${x + 1.5 + w / 2}" y="${y + ROWH / 2 + 3.5}" font-size="9" font-weight="600" fill="${st.ink}" text-anchor="middle">${op.kind}${op.mb}</text>`;
      out += `<text x="${x + 4}" y="${y + 10}" font-size="5.5" fill="${st.ink}" opacity="0.75">${op.stage}</text>`;
    }
  }
  out += `</svg>`;
  return out;
}

export function downloadSVG(sim, opts) {
  const svg = scheduleSVG(sim, opts);
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const cfg = sim.cfg;
  a.download = `pp-schedule-P${cfg.P}V${cfg.V}M${cfg.M}-${cfg.model}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
}
