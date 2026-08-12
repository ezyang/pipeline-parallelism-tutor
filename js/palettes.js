// Color themes for the schedule grid.
//
// 'microbatch' — identity by hue (validated categorical palette, light+dark),
//   op kind carried by fill variant: F solid, B tint+border, W pale+hatch.
// 'megatron' / 'zerobubble' — "paper style": color by op kind like the figures
//   in the literature (blue F, green B, orange W), microbatch as the printed
//   number, VPP chunk as a lighter shade. Approximations, not exact scans.

export const CATEGORICAL = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100',
          '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark:  ['#3987e5', '#d95926', '#199e70', '#c98500',
          '#d55181', '#008300', '#9085e9', '#e66767'],
};

export const THEMES = {
  microbatch: { name: 'Microbatch colors (default)', byKind: false },
  megatron: {
    name: 'Paper style — Megatron (blue F / green B)',
    byKind: true,
    kinds: { F: '#3274b5', B: '#6aa84f', W: '#e69138' },
  },
  zerobubble: {
    name: 'Paper style — Zero-bubble (F/B/W)',
    byKind: true,
    kinds: { F: '#4a89dc', B: '#3faf7d', W: '#f5a623' },
  },
};

// --- color math ------------------------------------------------------------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map(v =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

export function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function inkOn(bg) {
  return luminance(bg) > 0.42 ? '#0b0b0b' : '#ffffff';
}

// --- cell styling ------------------------------------------------------------
// Returns {bg, border, ink, hatch} for an op under a theme.

export function cellStyle(themeKey, mode, op, cfg) {
  const theme = THEMES[themeKey];
  const white = '#ffffff';
  if (theme.byKind) {
    let base = theme.kinds[op.kind];
    // VPP chunk shading: later chunks lighter, like the interleaved figures
    const chunk = Math.floor(op.stage / cfg.P);
    if (chunk > 0) base = mix(base, white, Math.min(0.55, 0.4 * chunk));
    return { bg: base, border: mix(base, '#000000', 0.35),
             ink: inkOn(base), hatch: op.kind === 'W' };
  }
  const pal = CATEGORICAL[mode];
  const base = pal[op.mb % pal.length];
  // B/W tint toward the surface so they recede in both modes
  const toward = mode === 'dark' ? '#1a1a19' : white;
  const inkFlat = mode === 'dark' ? '#ffffff' : '#0b0b0b';
  if (op.kind === 'F') {
    return { bg: base, border: mix(base, '#000000', 0.3), ink: inkOn(base), hatch: false };
  }
  if (op.kind === 'B') {
    const bg = mix(base, toward, 0.62);
    return { bg, border: base, ink: inkFlat, hatch: false };
  }
  const bg = mix(base, toward, 0.8); // W
  return { bg, border: base, ink: inkFlat, hatch: true };
}
