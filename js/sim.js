/*
 * Hue Swarm — physics core.
 *
 * Every ball has a hue on the colour wheel. For two balls whose hues are a
 * fraction d of the wheel apart (0 ≤ d ≤ ½) and a colour tolerance τ:
 *   similarity  S = max(0, 1 − d/τ)          1 for identical colours
 *   oppositeness O = max(0, 1 − (½ − d)/τ)   1 for opposite colours (red ↔ cyan)
 * Both fall off linearly, which sorts colours far better than a cosine (flat
 * near zero, so it barely tells "same" from "nearly the same").
 *
 * The pair weight is   w = α·S + β·O
 * where α collects the "similar colours …" rules and β the "opposite colours …"
 * rules (positive = attract, negative = repel). The force on a ball is
 *   a_i = K/N · Σ_j  w_ij · g(r_ij) · û_ij
 * with g(r) = 1 / (1 + r²/ℓ²): nearby balls matter most, distant crowds still
 * pull a little (≈ ℓ²/r²). ℓ is the "interaction range"; at "Global", g = 1.
 * Normalising by N keeps the look the same whatever the ball count.
 *
 * Summing that over every pair is O(N²), far too slow for 10 000+ balls, so the
 * sum is split in two:
 *   • near field: pairs in the 3×3 neighbouring grid cells are summed exactly
 *     (this is also where ball-ball collisions are resolved);
 *   • far field: a multi-level grid (a flat quadtree) holds per-cell sums of
 *     cos/sin of the hue, so the effect of a whole distant cell can be
 *     evaluated at once. The weight is expanded as a short Fourier series in Δ,
 *     w(Δ) ≈ c0 + c1·cos Δ + c2·cos 2Δ, which makes it separable. Distant
 *     crowds therefore act with a slightly blurred version of the colour rule.
 */
'use strict';

(function (root) {
  const TAU = Math.PI * 2;
  const AGG = 7;   // per-cell aggregate: n, Σx, Σy, Σcos h, Σsin h, Σcos 2h, Σsin 2h  (h as an angle)
  // per-cell far field, as a first-order local expansion about the cell centroid:
  // 5 channels × (Ex, Ey, Jxx, Jxy, Jyy)  where E is the field and J its Jacobian
  const FLD = 25;
  const MAX_CELLS = 160000;
  const NEAR_CAP = 40;       // max exact neighbours per cell range in the near field
  const FORCE_SCALE = 0.9;   // base colour-force strength, px/step² at scale 1
  const MOUSE_SCALE = 1.6;   // base mouse-force strength

  class Level {
    constructor() {
      this.gx = 0; this.gy = 0; this.cap = 0;
      this.agg = null; this.cx = null; this.cy = null; this.fld = null;
    }
    ensure(gx, gy) {
      this.gx = gx; this.gy = gy;
      const n = gx * gy;
      if (n > this.cap) {
        this.cap = Math.ceil(n * 1.25) + 16;
        this.agg = new Float64Array(this.cap * AGG);
        this.cx = new Float64Array(this.cap);
        this.cy = new Float64Array(this.cap);
        this.fld = new Float64Array(this.cap * FLD);
      }
    }
  }

  class Simulation {
    constructor(params) {
      this.p = params;
      this.n = 0;
      this.W = 800; this.H = 600;
      this.rad = 3;
      this.levels = [];
      this.nLevels = 0;
      this.cellCap = 0;
      this.cellStart = new Int32Array(1);
      this.cursor = new Int32Array(1);
      this.rng = new Int32Array(10);
      this.ox = 0; this.oy = 0; this.cs = 1; this.inv = 1;
      this.mouse = { x: -1e9, y: -1e9, vx: 0, vy: 0, active: false };
      this.stepMs = 0;
      this.steps = 0;
      this.allocate(0);
    }

    /* ---------- setup ---------- */

    allocate(n) {
      this.n = n;
      this.x = new Float64Array(n);
      this.y = new Float64Array(n);
      this.px = new Float64Array(n);
      this.py = new Float64Array(n);
      this.ax = new Float64Array(n);
      this.ay = new Float64Array(n);
      this.hue = new Float64Array(n);
      this.hc = new Float64Array(n);
      this.hs = new Float64Array(n);
      this.hc2 = new Float64Array(n);
      this.hs2 = new Float64Array(n);
      this.cellOf = new Int32Array(n);
      this.items = new Int32Array(n);
    }

    setWorld(W, H) {
      this.W = Math.max(50, W);
      this.H = Math.max(50, H);
      this.updateRadius();
    }

    setCount(n) {
      n = Math.max(1, Math.round(n));
      this.allocate(n);
      this.applyColors();
      this.updateRadius();
      this.randomize();
    }

    /** Ball radius chosen so the balls cover a fixed share of the screen. */
    updateRadius() {
      const n = Math.max(1, this.n);
      const r = Math.sqrt(0.2 * this.W * this.H / (n * Math.PI)) * (this.p.size || 1);
      this.rad = Math.min(40, Math.max(0.75, r));
    }

    /** Spread hues evenly around the wheel (or snap them to N distinct colours). */
    applyColors() {
      const n = this.n, k = this.p.colors | 0;
      const offset = Math.random();
      for (let i = 0; i < n; i++) {
        let h = k > 1 ? Math.floor(i * k / n) / k : i / n;
        h = k > 1 ? h : (h + offset) % 1;
        this.setHue(i, h);
      }
    }

    setHue(i, h) {
      h -= Math.floor(h);
      this.hue[i] = h;
      const a = h * TAU;
      this.hc[i] = Math.cos(a);
      this.hs[i] = Math.sin(a);
      this.hc2[i] = Math.cos(2 * a);
      this.hs2[i] = Math.sin(2 * a);
    }

    /** Scatter every ball to a random spot with a small random drift. */
    randomize() {
      const n = this.n, W = this.W, H = this.H;
      const m = Math.min(this.rad + 1, Math.min(W, H) * 0.25);
      const v0 = 0.6 * Math.max(0.4, Math.min(this.W, this.H) / 900);
      for (let i = 0; i < n; i++) {
        const x = m + Math.random() * (W - 2 * m);
        const y = m + Math.random() * (H - 2 * m);
        const a = Math.random() * TAU, v = Math.random() * v0;
        this.x[i] = x; this.y[i] = y;
        this.px[i] = x - Math.cos(a) * v;
        this.py[i] = y - Math.sin(a) * v;
      }
    }

    /** Pair weight for two hues (α: similar-colour rule, β: opposite-colour rule, τ: tolerance). */
    static weight(h1, h2, alpha, beta, tau) {
      let d = h1 - h2; if (d < 0) d = -d; if (d > 0.5) d = 1 - d;
      const S = 1 - d / tau, O = 1 - (0.5 - d) / tau;
      return (S > 0 ? alpha * S : 0) + (O > 0 ? beta * O : 0);
    }

    /** First Fourier coefficients of the pair weight as a function of hue angle. */
    fourier(alpha, beta, tau) {
      if (this._fa === alpha && this._fb === beta && this._ft === tau) return this._fc;
      const M = 720, c = [0, 0, 0];
      for (let k = 0; k < M; k++) {
        const t = (k + 0.5) / M, a = t * TAU, w = Simulation.weight(t, 0, alpha, beta, tau);
        c[0] += w; c[1] += w * Math.cos(a); c[2] += w * Math.cos(2 * a);
      }
      c[0] /= M; c[1] *= 2 / M; c[2] *= 2 / M;
      this._fa = alpha; this._fb = beta; this._ft = tau; this._fc = c;
      return c;
    }

    /** Index of the ball closest to (x, y), or -1. */
    nearest(x, y) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < this.n; i++) {
        const dx = this.x[i] - x, dy = this.y[i] - y, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    /* ---------- main step ---------- */

    step() {
      const t0 = performance.now();
      const p = this.p, n = this.n;
      if (!n) return;

      const A = p.attract / 100, R = p.repel / 100;
      let alpha = 0, beta = 0;
      if (p.simAttract) alpha += A;
      if (p.simRepel) alpha -= R;
      if (p.oppAttract) beta += A;
      if (p.oppRepel) beta -= R;
      const colorOn = alpha !== 0 || beta !== 0;

      this.setupGrid();
      this.bin();

      this.ax.fill(0);
      this.ay.fill(0);

      const scale = Math.min(this.W, this.H) / 900;
      if (colorOn) {
        // Interaction range: slider 0..100 → falloff length ℓ; 100 = global (no falloff).
        let invL2 = 0, nEff = n;
        if (p.range < 100) {
          const minDim = Math.min(this.W, this.H);
          const ell = minDim * 0.004 * Math.pow(250, p.range / 100);
          invL2 = 1 / (ell * ell);
          // expected Σ g over an evenly spread crowd, so strength feels similar at any range
          const Rs = Math.sqrt(this.W * this.H / Math.PI);
          const integral = Math.PI * ell * ell * Math.log(1 + (Rs * Rs) / (ell * ell));
          nEff = Math.max(Math.min(n, 8), n * Math.min(1, integral / (this.W * this.H)));
        }
        const K = FORCE_SCALE * scale / nEff;
        const tau = Math.min(0.5, Math.max(0.03, p.tolerance / 100));
        const c = this.fourier(alpha, beta, tau);
        this.aggregate();
        this.farField(invL2);
        this.applyFar(c[0], c[1], c[2], K);
        this.nearField(alpha, beta, tau, invL2, K);
      }

      this.external(scale);
      this.integrate();

      if (p.collisions) {
        this.bin();
        const iters = n > 20000 ? 1 : 2;
        for (let k = 0; k < iters; k++) {
          this.collide();
          this.walls();
        }
      } else {
        this.walls();
      }

      this.steps++;
      const dt = performance.now() - t0;
      this.stepMs = this.stepMs * 0.9 + dt * 0.1;
    }

    /* ---------- spatial grid ---------- */

    setupGrid() {
      const p = this.p, n = this.n, x = this.x, y = this.y;
      let minX = 0, minY = 0, maxX = this.W, maxY = this.H;
      if (!p.walls) {
        for (let i = 0; i < n; i++) {
          const xi = x[i], yi = y[i];
          if (xi < minX) minX = xi; else if (xi > maxX) maxX = xi;
          if (yi < minY) minY = yi; else if (yi > maxY) maxY = yi;
        }
      }
      minX -= 1; minY -= 1; maxX += 1; maxY += 1;

      const spanX = maxX - minX, spanY = maxY - minY;
      let cs = Math.max(this.rad * 4, 3);
      if ((spanX / cs) * (spanY / cs) > MAX_CELLS * 0.5) cs = Math.sqrt(spanX * spanY / (MAX_CELLS * 0.5));

      // Shift the whole grid by a random offset every step. The far-field
      // approximation is slightly discontinuous across cell borders; with fixed
      // borders balls slowly collect along them (visible straight lines), while
      // moving borders turn that error into harmless noise.
      let L = 0, lx = Math.ceil(spanX / cs), ly = Math.ceil(spanY / cs);
      while (lx > 4 || ly > 4) { lx = Math.ceil(lx / 2); ly = Math.ceil(ly / 2); L++; }
      const shift = cs * (1 << Math.max(0, L - 1));
      const ox = minX - Math.random() * shift, oy = minY - Math.random() * shift;
      const gx = Math.max(1, Math.ceil((maxX - ox) / cs)), gy = Math.max(1, Math.ceil((maxY - oy) / cs));
      this.ox = ox; this.oy = oy; this.cs = cs; this.inv = 1 / cs;

      let l = 0, kx = gx, ky = gy;
      for (;;) {
        if (!this.levels[l]) this.levels[l] = new Level();
        this.levels[l].ensure(kx, ky);
        if (kx <= 4 && ky <= 4) break;
        kx = Math.ceil(kx / 2); ky = Math.ceil(ky / 2);
        l++;
      }
      this.nLevels = l + 1;

      const cells = gx * gy;
      if (cells + 1 > this.cellCap) {
        this.cellCap = Math.ceil((cells + 1) * 1.25);
        this.cellStart = new Int32Array(this.cellCap);
        this.cursor = new Int32Array(this.cellCap);
      }
    }

    /** Counting sort of balls into level-0 cells. */
    bin() {
      const L = this.levels[0], gx = L.gx, gy = L.gy, cells = gx * gy;
      const n = this.n, x = this.x, y = this.y, cellOf = this.cellOf, items = this.items;
      const start = this.cellStart, cur = this.cursor;
      const ox = this.ox, oy = this.oy, inv = this.inv;
      start.fill(0, 0, cells + 1);
      for (let i = 0; i < n; i++) {
        let cx = Math.floor((x[i] - ox) * inv), cy = Math.floor((y[i] - oy) * inv);
        if (cx < 0) cx = 0; else if (cx >= gx) cx = gx - 1;
        if (cy < 0) cy = 0; else if (cy >= gy) cy = gy - 1;
        const c = cy * gx + cx;
        cellOf[i] = c;
        start[c + 1]++;
      }
      for (let c = 0; c < cells; c++) start[c + 1] += start[c];
      for (let c = 0; c < cells; c++) cur[c] = start[c];
      for (let i = 0; i < n; i++) items[cur[cellOf[i]]++] = i;
    }

    /* ---------- far field (multi-level grid) ---------- */

    aggregate() {
      const n = this.n, x = this.x, y = this.y;
      const hc = this.hc, hs = this.hs, hc2 = this.hc2, hs2 = this.hs2, cellOf = this.cellOf;
      const L0 = this.levels[0];
      let agg = L0.agg;
      agg.fill(0, 0, L0.gx * L0.gy * AGG);
      for (let i = 0; i < n; i++) {
        const o = cellOf[i] * AGG;
        agg[o] += 1;
        agg[o + 1] += x[i];
        agg[o + 2] += y[i];
        agg[o + 3] += hc[i];
        agg[o + 4] += hs[i];
        agg[o + 5] += hc2[i];
        agg[o + 6] += hs2[i];
      }
      for (let l = 0; l < this.nLevels - 1; l++) {
        const C = this.levels[l], P = this.levels[l + 1];
        const ca = C.agg, pa = P.agg, gx = C.gx, gy = C.gy, pgx = P.gx;
        pa.fill(0, 0, P.gx * P.gy * AGG);
        for (let cy = 0; cy < gy; cy++) {
          const prow = (cy >> 1) * pgx;
          for (let cx = 0; cx < gx; cx++) {
            const o = (cy * gx + cx) * AGG;
            if (ca[o] === 0) continue;
            const po = (prow + (cx >> 1)) * AGG;
            pa[po] += ca[o];
            pa[po + 1] += ca[o + 1];
            pa[po + 2] += ca[o + 2];
            pa[po + 3] += ca[o + 3];
            pa[po + 4] += ca[o + 4];
            pa[po + 5] += ca[o + 5];
            pa[po + 6] += ca[o + 6];
          }
        }
      }
      for (let l = 0; l < this.nLevels; l++) {
        const L = this.levels[l], a = L.agg, cxs = L.cx, cys = L.cy, cells = L.gx * L.gy;
        for (let c = 0; c < cells; c++) {
          const m = a[c * AGG];
          if (m > 0) { cxs[c] = a[c * AGG + 1] / m; cys[c] = a[c * AGG + 2] / m; }
        }
      }
    }

    /**
     * Cell-to-cell interactions. At each level a cell interacts with the
     * children of its parent's neighbours that are not its own neighbours;
     * the top level interacts with every non-neighbour. Fields are then pushed
     * down so each level-0 cell holds the field of everything outside its
     * 3×3 neighbourhood.
     */
    farField(invL2) {
      const top = this.nLevels - 1;
      for (let l = 0; l <= top; l++) {
        const L = this.levels[l], gx = L.gx, gy = L.gy;
        const agg = L.agg, cxs = L.cx, cys = L.cy, fld = L.fld;
        fld.fill(0, 0, gx * gy * FLD);
        for (let ty = 0; ty < gy; ty++) {
          let sy0, sy1;
          if (l === top) { sy0 = 0; sy1 = gy - 1; } else {
            const pty = ty >> 1;
            sy0 = Math.max(0, 2 * pty - 2); sy1 = Math.min(gy - 1, 2 * pty + 3);
          }
          for (let tx = 0; tx < gx; tx++) {
            const t = ty * gx + tx;
            if (agg[t * AGG] === 0) continue;
            let sx0, sx1;
            if (l === top) { sx0 = 0; sx1 = gx - 1; } else {
              const ptx = tx >> 1;
              sx0 = Math.max(0, 2 * ptx - 2); sx1 = Math.min(gx - 1, 2 * ptx + 3);
            }
            const tcx = cxs[t], tcy = cys[t];
            // local accumulators: field (x, y) and Jacobian (xx, xy, yy) for each channel
            let a0x = 0, a0y = 0, a0a = 0, a0b = 0, a0c = 0;
            let a1x = 0, a1y = 0, a1a = 0, a1b = 0, a1c = 0;
            let a2x = 0, a2y = 0, a2a = 0, a2b = 0, a2c = 0;
            let a3x = 0, a3y = 0, a3a = 0, a3b = 0, a3c = 0;
            let a4x = 0, a4y = 0, a4a = 0, a4b = 0, a4c = 0;
            for (let sy = sy0; sy <= sy1; sy++) {
              const near = sy - ty <= 1 && ty - sy <= 1;
              for (let sx = sx0; sx <= sx1; sx++) {
                if (near && sx - tx <= 1 && tx - sx <= 1) continue;
                const s = sy * gx + sx, so = s * AGG;
                const m = agg[so];
                if (m === 0) continue;
                const dx = cxs[s] - tcx, dy = cys[s] - tcy;
                const r2 = dx * dx + dy * dy;
                // kernel K(d) = g(r)·d/r and its Jacobian
                const ir = 1 / Math.sqrt(r2);
                const g = 1 / (1 + r2 * invL2);             // g(r)
                const gp = -2 * r2 * ir * invL2 * g * g;     // g'(r)
                const ga = g * ir;                           // g/r
                const gb = (gp - ga) * ir * ir;              // (g'(r) − g/r) / r²
                const kx = ga * dx, ky = ga * dy;
                const jxx = ga + gb * dx * dx, jxy = gb * dx * dy, jyy = ga + gb * dy * dy;
                const w1 = agg[so + 3], w2 = agg[so + 4], w3 = agg[so + 5], w4 = agg[so + 6];
                a0x += kx * m; a0y += ky * m; a0a += jxx * m; a0b += jxy * m; a0c += jyy * m;
                a1x += kx * w1; a1y += ky * w1; a1a += jxx * w1; a1b += jxy * w1; a1c += jyy * w1;
                a2x += kx * w2; a2y += ky * w2; a2a += jxx * w2; a2b += jxy * w2; a2c += jyy * w2;
                a3x += kx * w3; a3y += ky * w3; a3a += jxx * w3; a3b += jxy * w3; a3c += jyy * w3;
                a4x += kx * w4; a4y += ky * w4; a4a += jxx * w4; a4b += jxy * w4; a4c += jyy * w4;
              }
            }
            const o = t * FLD;
            fld[o] = a0x; fld[o + 1] = a0y; fld[o + 2] = a0a; fld[o + 3] = a0b; fld[o + 4] = a0c;
            fld[o + 5] = a1x; fld[o + 6] = a1y; fld[o + 7] = a1a; fld[o + 8] = a1b; fld[o + 9] = a1c;
            fld[o + 10] = a2x; fld[o + 11] = a2y; fld[o + 12] = a2a; fld[o + 13] = a2b; fld[o + 14] = a2c;
            fld[o + 15] = a3x; fld[o + 16] = a3y; fld[o + 17] = a3a; fld[o + 18] = a3b; fld[o + 19] = a3c;
            fld[o + 20] = a4x; fld[o + 21] = a4y; fld[o + 22] = a4a; fld[o + 23] = a4b; fld[o + 24] = a4c;
          }
        }
      }
      // Push expansions down: shift the parent's expansion to the child's centroid and add.
      for (let l = top - 1; l >= 0; l--) {
        const C = this.levels[l], P = this.levels[l + 1];
        const cf = C.fld, pf = P.fld, ca = C.agg, gx = C.gx, gy = C.gy, pgx = P.gx;
        const ccx = C.cx, ccy = C.cy, pcx = P.cx, pcy = P.cy;
        for (let cy = 0; cy < gy; cy++) {
          const prow = (cy >> 1) * pgx;
          for (let cx = 0; cx < gx; cx++) {
            const c = cy * gx + cx;
            if (ca[c * AGG] === 0) continue;
            const pc = prow + (cx >> 1);
            const ddx = ccx[c] - pcx[pc], ddy = ccy[c] - pcy[pc];
            const o = c * FLD, po = pc * FLD;
            for (let k = 0; k < FLD; k += 5) {
              const jxx = pf[po + k + 2], jxy = pf[po + k + 3], jyy = pf[po + k + 4];
              cf[o + k] += pf[po + k] - (jxx * ddx + jxy * ddy);
              cf[o + k + 1] += pf[po + k + 1] - (jxy * ddx + jyy * ddy);
              cf[o + k + 2] += jxx;
              cf[o + k + 3] += jxy;
              cf[o + k + 4] += jyy;
            }
          }
        }
      }
    }

    applyFar(c0, c1, c2, K) {
      const n = this.n, f = this.levels[0].fld, cxs = this.levels[0].cx, cys = this.levels[0].cy;
      const cellOf = this.cellOf, x = this.x, y = this.y;
      const hc = this.hc, hs = this.hs, hc2 = this.hc2, hs2 = this.hs2, ax = this.ax, ay = this.ay;
      for (let i = 0; i < n; i++) {
        const c = cellOf[i], o = c * FLD;
        const dx = x[i] - cxs[c], dy = y[i] - cys[c];
        const w0 = K * c0, w1 = K * c1 * hc[i], w2 = K * c1 * hs[i], w3 = K * c2 * hc2[i], w4 = K * c2 * hs2[i];
        // combine the five channel expansions with this ball's hue weights
        const ex = w0 * f[o] + w1 * f[o + 5] + w2 * f[o + 10] + w3 * f[o + 15] + w4 * f[o + 20];
        const ey = w0 * f[o + 1] + w1 * f[o + 6] + w2 * f[o + 11] + w3 * f[o + 16] + w4 * f[o + 21];
        const jxx = w0 * f[o + 2] + w1 * f[o + 7] + w2 * f[o + 12] + w3 * f[o + 17] + w4 * f[o + 22];
        const jxy = w0 * f[o + 3] + w1 * f[o + 8] + w2 * f[o + 13] + w3 * f[o + 18] + w4 * f[o + 23];
        const jyy = w0 * f[o + 4] + w1 * f[o + 9] + w2 * f[o + 14] + w3 * f[o + 19] + w4 * f[o + 24];
        ax[i] += ex - (jxx * dx + jxy * dy);
        ay[i] += ey - (jxy * dx + jyy * dy);
      }
    }

    /* ---------- near field (exact pairs) ---------- */

    /** Fill this.rng with the forward-neighbour ranges of cell (cx, cy); returns range count. */
    neighbourRanges(c, cx, cy, gx, gy) {
      const start = this.cellStart, rng = this.rng;
      let nr = 1; // slot 0 is reserved for the cell itself
      if (cx + 1 < gx) {
        const s = start[c + 1], e = start[c + 2];
        if (e > s) { rng[2 * nr] = s; rng[2 * nr + 1] = e; nr++; }
      }
      if (cy + 1 < gy) {
        const b = c + gx;
        const x0 = cx > 0 ? b - 1 : b, x1 = cx + 1 < gx ? b + 1 : b;
        // cells b-1 .. b+1 on the next row are contiguous in the sorted list
        const s = start[x0], e = start[x1 + 1];
        if (e > s) { rng[2 * nr] = s; rng[2 * nr + 1] = e; nr++; }
      }
      return nr;
    }

    nearField(alpha, beta, tau, invL2, K) {
      const L = this.levels[0], gx = L.gx, gy = L.gy;
      const start = this.cellStart, items = this.items, rng = this.rng;
      const x = this.x, y = this.y, hue = this.hue, ax = this.ax, ay = this.ay;
      const coreR = 2 * this.rad, invCore = 1 / coreR, invTau = 1 / tau;
      for (let cy = 0; cy < gy; cy++) {
        for (let cx = 0; cx < gx; cx++) {
          const c = cy * gx + cx;
          const s0 = start[c], e0 = start[c + 1];
          if (s0 === e0) continue;
          const nr = this.neighbourRanges(c, cx, cy, gx, gy);
          for (let a = s0; a < e0; a++) {
            const i = items[a];
            const xi = x[i], yi = y[i], hi = hue[i];
            let axi = 0, ayi = 0;
            rng[0] = a + 1; rng[1] = e0;
            for (let k = 0; k < nr; k++) {
              const bStart = rng[2 * k], bEnd = rng[2 * k + 1];
              // Crowded cells (only possible with collisions off, when balls pile
              // up on top of each other): sample every `stride`-th neighbour and
              // scale up its force, so the cost stays bounded. Unbiased on average.
              const stride = bEnd - bStart > NEAR_CAP ? Math.floor((bEnd - bStart) / NEAR_CAP) : 1;
              const kf = K * stride;
              for (let b = stride > 1 ? bStart + ((Math.random() * stride) | 0) : bStart; b < bEnd; b += stride) {
                const j = items[b];
                const dx = x[j] - xi, dy = y[j] - yi;
                const r2 = dx * dx + dy * dy;
                if (r2 < 1e-9) continue;
                let d = hue[j] - hi; if (d < 0) d = -d; if (d > 0.5) d = 1 - d;
                const S = 1 - d * invTau, O = 1 - (0.5 - d) * invTau;
                const w = (S > 0 ? alpha * S : 0) + (O > 0 ? beta * O : 0);
                if (w === 0) continue;
                const r = Math.sqrt(r2);
                let f = kf * w / ((1 + r2 * invL2) * r);
                if (r < coreR) f *= r * invCore;
                const fx = f * dx, fy = f * dy;
                axi += fx; ayi += fy;
                ax[j] -= fx; ay[j] -= fy;
              }
            }
            ax[i] += axi; ay[i] += ayi;
          }
        }
      }
    }

    collide() {
      const L = this.levels[0], gx = L.gx, gy = L.gy;
      const start = this.cellStart, items = this.items, rng = this.rng;
      const x = this.x, y = this.y;
      const dmin = 2 * this.rad, d2min = dmin * dmin;
      for (let cy = 0; cy < gy; cy++) {
        for (let cx = 0; cx < gx; cx++) {
          const c = cy * gx + cx;
          const s0 = start[c], e0 = start[c + 1];
          if (s0 === e0) continue;
          const nr = this.neighbourRanges(c, cx, cy, gx, gy);
          for (let a = s0; a < e0; a++) {
            const i = items[a];
            let xi = x[i], yi = y[i];
            rng[0] = a + 1; rng[1] = e0;
            for (let k = 0; k < nr; k++) {
              const bEnd = rng[2 * k + 1];
              for (let b = rng[2 * k]; b < bEnd; b++) {
                const j = items[b];
                const dx = x[j] - xi, dy = y[j] - yi;
                const r2 = dx * dx + dy * dy;
                if (r2 >= d2min) continue;
                if (r2 < 1e-10) {
                  // perfectly stacked: nudge apart in a random direction
                  const ang = Math.random() * TAU, h = dmin * 0.25;
                  x[j] += Math.cos(ang) * h; y[j] += Math.sin(ang) * h;
                  continue;
                }
                const r = Math.sqrt(r2);
                const kk = (dmin - r) / r * 0.5;
                const ox = dx * kk, oy = dy * kk;
                xi -= ox; yi -= oy;
                x[j] += ox; y[j] += oy;
              }
            }
            x[i] = xi; y[i] = yi;
          }
        }
      }
    }

    /* ---------- external forces, integration, bounds ---------- */

    external(scale) {
      const p = this.p, n = this.n, x = this.x, y = this.y, ax = this.ax, ay = this.ay;
      if (p.centerPull) {
        const k = 0.0006 * (p.centerStrength / 100);
        const cx = this.W / 2, cy = this.H / 2;
        for (let i = 0; i < n; i++) {
          ax[i] -= (x[i] - cx) * k;
          ay[i] -= (y[i] - cy) * k;
        }
      }
      if (p.jiggle > 0) {
        const j = 0.25 * scale * Math.pow(p.jiggle / 100, 2);
        for (let i = 0; i < n; i++) {
          ax[i] += (Math.random() - 0.5) * j;
          ay[i] += (Math.random() - 0.5) * j;
        }
      }
      const m = this.mouse;
      if (m.active && p.mouseMode !== 'off' && p.mouseStrength > 0) {
        const Rm = p.mouseRadius, R2 = Rm * Rm, mx = m.x, my = m.y;
        const S = MOUSE_SCALE * Math.max(0.5, scale) * (p.mouseStrength / 100);
        const mode = p.mouseMode;
        const px = this.px, py = this.py;
        const stirK = 0.35 * (p.mouseStrength / 100);
        for (let i = 0; i < n; i++) {
          const dx = x[i] - mx, dy = y[i] - my, d2 = dx * dx + dy * dy;
          if (d2 >= R2) continue;
          const d = Math.sqrt(d2) + 1e-6;
          let f = 1 - d / Rm; f *= f;
          if (mode === 'push') {
            ax[i] += dx / d * S * f; ay[i] += dy / d * S * f;
          } else if (mode === 'pull') {
            ax[i] -= dx / d * S * f; ay[i] -= dy / d * S * f;
          } else if (mode === 'swirl') {
            ax[i] += (-dy / d - 0.15 * dx / d) * S * f;
            ay[i] += (dx / d - 0.15 * dy / d) * S * f;
          } else if (mode === 'stir') {
            const vx = x[i] - px[i], vy = y[i] - py[i];
            const g = Math.min(1, f * stirK * 3);
            px[i] -= (m.vx - vx) * g;
            py[i] -= (m.vy - vy) * g;
          }
        }
      }
    }

    integrate() {
      const p = this.p, n = this.n;
      const x = this.x, y = this.y, px = this.px, py = this.py, ax = this.ax, ay = this.ay;
      const fr = Math.pow(p.friction / 100, 1.5) * 0.35;
      const damp = 1 - fr;
      const vmax = Math.max(1.5, this.rad * 1.6), vmax2 = vmax * vmax;
      for (let i = 0; i < n; i++) {
        const xi = x[i], yi = y[i];
        let vx = (xi - px[i]) * damp + ax[i];
        let vy = (yi - py[i]) * damp + ay[i];
        const v2 = vx * vx + vy * vy;
        if (v2 > vmax2) { const s = vmax / Math.sqrt(v2); vx *= s; vy *= s; }
        px[i] = xi; py[i] = yi;
        x[i] = xi + vx; y[i] = yi + vy;
      }
    }

    walls() {
      const n = this.n, x = this.x, y = this.y, px = this.px, py = this.py;
      if (this.p.walls) {
        const r = this.rad, x0 = r, y0 = r, x1 = this.W - r, y1 = this.H - r, b = 0.5;
        for (let i = 0; i < n; i++) {
          const xi = x[i], yi = y[i];
          if (xi < x0) { const vx = xi - px[i]; x[i] = x0; px[i] = vx < 0 ? x0 + vx * b : x0; }
          else if (xi > x1) { const vx = xi - px[i]; x[i] = x1; px[i] = vx > 0 ? x1 + vx * b : x1; }
          if (yi < y0) { const vy = yi - py[i]; y[i] = y0; py[i] = vy < 0 ? y0 + vy * b : y0; }
          else if (yi > y1) { const vy = yi - py[i]; y[i] = y1; py[i] = vy > 0 ? y1 + vy * b : y1; }
        }
      } else {
        // open space, but keep strays within a generous invisible fence
        const W = this.W, H = this.H, x0 = -W, x1 = 2 * W, y0 = -H, y1 = 2 * H;
        for (let i = 0; i < n; i++) {
          if (x[i] < x0) { x[i] = x0; px[i] = x0; } else if (x[i] > x1) { x[i] = x1; px[i] = x1; }
          if (y[i] < y0) { y[i] = y0; py[i] = y0; } else if (y[i] > y1) { y[i] = y1; py[i] = y1; }
        }
      }
    }
  }

  root.Simulation = Simulation;
})(typeof window !== 'undefined' ? window : globalThis);
