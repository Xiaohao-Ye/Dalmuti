/* Balatro-stijl swirl achtergrond (WebGL).
   Gebaseerd op de bekende "paint swirl" shader uit Balatro. */
(function () {
  'use strict';
  const canvas = document.getElementById('bg');
  const gl = canvas.getContext('webgl', { antialias: false, depth: false });

  if (!gl) {
    // Fallback: statische gradient via CSS
    canvas.style.background =
      'radial-gradient(circle at 50% 40%, #2b1e4d 0%, #16102e 60%, #0b0819 100%)';
    return;
  }

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG = `
    precision highp float;
    uniform float u_time;
    uniform vec2  u_res;

    #define SPIN_EASE 0.5
    const float spin_amount = 0.8;
    const float contrast    = 1.6;

    void main() {
      vec2 screenSize = u_res;
      // Pixelate voor die chunky Balatro-look
      float pixel_size = length(screenSize) / 900.0;
      vec2 screen_coords = floor(gl_FragCoord.xy / pixel_size) * pixel_size;

      vec2 uv = (screen_coords - 0.5 * screenSize) / length(screenSize);
      float uv_len = length(uv);

      float speed = (u_time * SPIN_EASE * 0.1) + 302.2;
      float new_pixel_angle = atan(uv.y, uv.x) + speed
        - SPIN_EASE * 20.0 * (spin_amount * uv_len + (1.0 - spin_amount));
      vec2 mid = (screenSize / length(screenSize)) / 2.0;
      uv = vec2(uv_len * cos(new_pixel_angle) + mid.x,
                uv_len * sin(new_pixel_angle) + mid.y) - mid;

      uv *= 30.0;
      speed = u_time * 1.2;
      vec2 uv2 = vec2(uv.x + uv.y);

      for (int i = 0; i < 5; i++) {
        uv2 += sin(max(uv.x, uv.y)) + uv;
        uv  += 0.5 * vec2(cos(5.1123314 + 0.353 * uv2.y + speed * 0.131121),
                          sin(uv2.x - 0.113 * speed));
        uv  -= 1.0 * cos(uv.x + uv.y) - 1.0 * sin(uv.x * 0.711 - uv.y);
      }

      float contrast_mod = (0.25 * contrast + 0.5 * spin_amount + 1.2);
      float paint_res = min(2.0, max(0.0, length(uv) * 0.035 * contrast_mod));
      float c1p = max(0.0, 1.0 - contrast_mod * abs(1.0 - paint_res));
      float c2p = max(0.0, 1.0 - contrast_mod * abs(paint_res));
      float c3p = 1.0 - min(1.0, c1p + c2p);

      // Koninklijk paars / blauw / bijna-zwart
      vec4 colour_1 = vec4(0.34, 0.14, 0.52, 1.0);
      vec4 colour_2 = vec4(0.12, 0.20, 0.55, 1.0);
      vec4 colour_3 = vec4(0.05, 0.04, 0.12, 1.0);

      vec4 ret_col = (0.3 / contrast) * colour_1
        + (1.0 - 0.3 / contrast)
        * (colour_1 * c1p + colour_2 * c2p + vec4(c3p * colour_3.rgb, c3p * colour_1.a));

      // Iets dimmen zodat de UI eruit springt
      gl_FragColor = vec4(ret_col.rgb * 0.55, 1.0);
    }
  `;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uTime = gl.getUniformLocation(prog, 'u_time');
  const uRes = gl.getUniformLocation(prog, 'u_res');

  function resize() {
    // Halve resolutie renderen: sneller én past bij de pixel-look
    const w = Math.floor(window.innerWidth / 2);
    const h = Math.floor(window.innerHeight / 2);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }
  window.addEventListener('resize', resize);
  resize();

  const start = performance.now();
  function frame(now) {
    resize();
    gl.uniform1f(uTime, (now - start) / 1000);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
