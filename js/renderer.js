/*
 * Hue Swarm — renderer. Draws every ball as a WebGL point sprite (one draw call
 * for all balls) with optional 3D shading, additive glow and motion trails.
 * Falls back to Canvas 2D if WebGL is unavailable.
 */
'use strict';

(function (root) {
  const VERT = `
attribute vec2 aPos;
attribute float aHue;
uniform vec2 uView;
uniform float uSize;
uniform float uSat;
varying vec3 vColor;
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
void main() {
  vec2 p = aPos / uView * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  gl_PointSize = uSize;
  vColor = hsv2rgb(vec3(aHue, uSat, 1.0));
}`;

  const FRAG = `
precision mediump float;
varying vec3 vColor;
uniform float uEdge;   // point-coord radius of the ball edge (>= 1 adds AA margin)
uniform float uAA;     // anti-alias width in normalized units
uniform float uShade;  // 0 = flat, 1 = shaded sphere
uniform float uAlpha;
void main() {
  vec2 c = (gl_PointCoord * 2.0 - 1.0) * uEdge;
  float d2 = dot(c, c);
  if (d2 > 1.0 + uAA * 2.0) discard;
  float d = sqrt(d2);
  float a = 1.0 - smoothstep(1.0 - uAA, 1.0 + uAA * 0.5, d);
  vec3 col = vColor;
  if (uShade > 0.5) {
    float z = sqrt(max(0.0, 1.0 - min(d2, 1.0)));
    vec2 h = c - vec2(-0.38, -0.42);
    float spec = exp(-dot(h, h) * 7.0);
    col = col * (0.42 + 0.58 * z) + vec3(spec * 0.45);
  }
  a *= uAlpha;
  gl_FragColor = vec4(col * a, a);
}`;

  const FADE_VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FADE_FRAG = `
precision mediump float;
uniform float uFade;
void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uFade); }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    }
    return s;
  }

  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
    }
    return p;
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.W = 1; this.H = 1; this.dpr = 1;
      this.buf = new Float32Array(0);
      this.needsClear = true;
      let gl = null;
      try {
        const opts = { alpha: false, antialias: false, depth: false, stencil: false,
          premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
        gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
        if (gl) this.initGL(gl);
      } catch (e) {
        console.warn('WebGL unavailable, using Canvas 2D', e);
        gl = null;
      }
      if (!gl) {
        this.gl = null;
        this.ctx = canvas.getContext('2d');
        this.mode = '2d';
      }
    }

    initGL(gl) {
      this.gl = gl;
      this.mode = 'webgl';
      this.prog = program(gl, VERT, FRAG);
      this.aPos = gl.getAttribLocation(this.prog, 'aPos');
      this.aHue = gl.getAttribLocation(this.prog, 'aHue');
      this.u = {};
      for (const k of ['uView', 'uSize', 'uSat', 'uEdge', 'uAA', 'uShade', 'uAlpha']) {
        this.u[k] = gl.getUniformLocation(this.prog, k);
      }
      this.vbo = gl.createBuffer();
      this.vboCap = 0;

      this.fadeProg = program(gl, FADE_VERT, FADE_FRAG);
      this.fadePos = gl.getAttribLocation(this.fadeProg, 'aPos');
      this.uFade = gl.getUniformLocation(this.fadeProg, 'uFade');
      this.quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
      this.maxPoint = range ? range[1] : 64;
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
    }

    resize(W, H, dpr) {
      this.W = W; this.H = H; this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(W * dpr));
      this.canvas.height = Math.max(1, Math.round(H * dpr));
      this.canvas.style.width = W + 'px';
      this.canvas.style.height = H + 'px';
      this.needsClear = true;
    }

    clear() { this.needsClear = true; }

    draw(sim, p) {
      if (this.mode === 'webgl') this.drawGL(sim, p); else this.draw2D(sim, p);
    }

    drawGL(sim, p) {
      const gl = this.gl, n = sim.n;
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      if (p.trails && !this.needsClear) {
        // fade the previous frame instead of clearing it
        gl.useProgram(this.fadeProg);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
        gl.enableVertexAttribArray(this.fadePos);
        gl.vertexAttribPointer(this.fadePos, 2, gl.FLOAT, false, 0, 0);
        const len = p.trailLength / 100;
        gl.uniform1f(this.uFade, Math.max(0.015, 0.5 * Math.pow(1 - len, 2)));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disableVertexAttribArray(this.fadePos);
      } else {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.needsClear = false;
      }
      if (!n) return;

      if (this.buf.length < n * 3) this.buf = new Float32Array(Math.ceil(n * 1.25) * 3);
      const b = this.buf, x = sim.x, y = sim.y, h = sim.hue;
      for (let i = 0, o = 0; i < n; i++, o += 3) { b[o] = x[i]; b[o + 1] = y[i]; b[o + 2] = h[i]; }

      gl.useProgram(this.prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      if (this.vboCap < n) {
        this.vboCap = Math.ceil(n * 1.25);
        gl.bufferData(gl.ARRAY_BUFFER, this.vboCap * 12, gl.DYNAMIC_DRAW);
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, b.subarray(0, n * 3));
      gl.enableVertexAttribArray(this.aPos);
      gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 12, 0);
      gl.enableVertexAttribArray(this.aHue);
      gl.vertexAttribPointer(this.aHue, 1, gl.FLOAT, false, 12, 8);

      const diam = Math.max(1, 2 * sim.rad * this.dpr);
      const size = Math.min(this.maxPoint, diam + 2);
      const edge = size / diam;
      gl.uniform2f(this.u.uView, this.W, this.H);
      gl.uniform1f(this.u.uSize, size);
      gl.uniform1f(this.u.uSat, 0.88);
      gl.uniform1f(this.u.uEdge, edge);
      gl.uniform1f(this.u.uAA, Math.min(0.5, 1.2 / diam));
      gl.uniform1f(this.u.uShade, p.shading && diam >= 4 ? 1 : 0);
      gl.uniform1f(this.u.uAlpha, p.glow ? 0.55 : 1);
      if (p.glow) gl.blendFunc(gl.ONE, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.disableVertexAttribArray(this.aPos);
      gl.disableVertexAttribArray(this.aHue);
    }

    draw2D(sim, p) {
      const ctx = this.ctx, n = sim.n, dpr = this.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (p.trails && !this.needsClear) {
        ctx.fillStyle = `rgba(0,0,0,${Math.max(0.015, 0.5 * Math.pow(1 - p.trailLength / 100, 2))})`;
      } else {
        ctx.fillStyle = '#000';
        this.needsClear = false;
      }
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = p.glow ? 'lighter' : 'source-over';
      const BUCKETS = 48, r = sim.rad, d = r * 2;
      if (!this.buckets || this.buckets.length !== BUCKETS) {
        this.buckets = Array.from({ length: BUCKETS }, () => []);
        this.bucketColors = Array.from({ length: BUCKETS }, (_, k) => `hsl(${(k / BUCKETS) * 360},90%,55%)`);
      }
      const bk = this.buckets;
      for (let k = 0; k < BUCKETS; k++) bk[k].length = 0;
      for (let i = 0; i < n; i++) bk[Math.floor(sim.hue[i] * BUCKETS) % BUCKETS].push(i);
      for (let k = 0; k < BUCKETS; k++) {
        const list = bk[k];
        if (!list.length) continue;
        ctx.fillStyle = this.bucketColors[k];
        ctx.beginPath();
        for (let m = 0; m < list.length; m++) {
          const i = list[m];
          if (r < 2) { ctx.rect(sim.x[i] - r, sim.y[i] - r, d, d); }
          else { ctx.moveTo(sim.x[i] + r, sim.y[i]); ctx.arc(sim.x[i], sim.y[i], r, 0, Math.PI * 2); }
        }
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  root.Renderer = Renderer;
})(window);
