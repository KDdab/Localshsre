/**
 * Self-contained, dependency-free QR Code Generator.
 * Encodes text/URLs into QR Code matrices (Model 2, Byte Mode, ECC Level M)
 * and draws directly onto an HTML5 Canvas.
 */
(function(global) {
  'use strict';

  const EXP_TABLE = new Uint8Array(256);
  const LOG_TABLE = new Uint8Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP_TABLE[i] = x;
      LOG_TABLE[x] = i;
      x <<= 1;
      if (x & 256) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) {
      EXP_TABLE[i] = EXP_TABLE[i - 255];
    }
  })();

  function gfMul(x, y) {
    if (x === 0 || y === 0) return 0;
    return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
  }

  function polyMul(p1, p2) {
    const res = new Uint8Array(p1.length + p2.length - 1);
    for (let i = 0; i < p1.length; i++) {
      for (let j = 0; j < p2.length; j++) {
        res[i + j] ^= gfMul(p1[i], p2[j]);
      }
    }
    return res;
  }

  function polyRest(poly, gen) {
    const res = new Uint8Array(poly);
    for (let i = 0; i < poly.length - gen.length + 1; i++) {
      const coef = res[i];
      if (coef !== 0) {
        for (let j = 1; j < gen.length; j++) {
          res[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return res.subarray(poly.length - gen.length + 1);
  }

  function getGeneratorPoly(deg) {
    let gen = new Uint8Array([1]);
    for (let i = 0; i < deg; i++) {
      gen = polyMul(gen, new Uint8Array([1, EXP_TABLE[i]]));
    }
    return gen;
  }

  const VERSION_CAPACITIES = [
    { ver: 1, total: 26, data: 16, ec: 10, size: 21, align: [] },
    { ver: 2, total: 44, data: 28, ec: 16, size: 25, align: [6, 18] },
    { ver: 3, total: 70, data: 44, ec: 26, size: 29, align: [6, 22] },
    { ver: 4, total: 100, data: 64, ec: 36, size: 33, align: [6, 26] },
    { ver: 5, total: 134, data: 86, ec: 48, size: 37, align: [6, 30] },
    { ver: 6, total: 172, data: 108, ec: 64, size: 41, align: [6, 34] },
    { ver: 7, total: 196, data: 124, ec: 72, size: 45, align: [6, 22, 38] }
  ];

  function selectVersion(dataLen) {
    for (const v of VERSION_CAPACITIES) {
      const headerBits = 4 + 8;
      const totalBits = (dataLen * 8) + headerBits;
      if (Math.ceil(totalBits / 8) <= v.data) return v;
    }
    return VERSION_CAPACITIES[VERSION_CAPACITIES.length - 1];
  }

  function encodeData(str, verInfo) {
    const utf8 = unescape(encodeURIComponent(str));
    const bytes = [];
    for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));

    const bitBuffer = [];
    function putBits(num, count) {
      for (let i = count - 1; i >= 0; i--) {
        bitBuffer.push((num >>> i) & 1);
      }
    }

    putBits(0b0100, 4); // Byte mode
    putBits(bytes.length, 8);
    for (const b of bytes) putBits(b, 8);

    const dataCapacityBits = verInfo.data * 8;
    const termLen = Math.min(4, dataCapacityBits - bitBuffer.length);
    putBits(0, termLen);

    while (bitBuffer.length % 8 !== 0) bitBuffer.push(0);

    const padBytes = [0xec, 0x11];
    let padIdx = 0;
    while (bitBuffer.length < dataCapacityBits) {
      putBits(padBytes[padIdx % 2], 8);
      padIdx++;
    }

    const dataWords = new Uint8Array(verInfo.data);
    for (let i = 0; i < dataWords.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) {
        b = (b << 1) | bitBuffer[i * 8 + j];
      }
      dataWords[i] = b;
    }

    const gen = getGeneratorPoly(verInfo.ec);
    const toEncode = new Uint8Array(verInfo.data + verInfo.ec);
    toEncode.set(dataWords);
    const ecWords = polyRest(toEncode, gen);

    const fullCodewords = new Uint8Array(verInfo.total);
    fullCodewords.set(dataWords);
    fullCodewords.set(ecWords, verInfo.data);
    return fullCodewords;
  }

  function createMatrix(verInfo, codewords) {
    const size = verInfo.size;
    const matrix = Array.from({ length: size }, () => Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => Array(size).fill(false));

    function setModule(r, c, val, isRes = true) {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        matrix[r][c] = val ? 1 : 0;
        if (isRes) reserved[r][c] = true;
      }
    }

    function addFinder(row, col) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const nr = row + r, nc = col + c;
          if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
          if ((r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
              (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
            setModule(nr, nc, 1);
          } else {
            setModule(nr, nc, 0);
          }
        }
      }
    }
    addFinder(0, 0);
    addFinder(0, size - 7);
    addFinder(size - 7, 0);

    if (verInfo.align.length >= 2) {
      const pos = verInfo.align;
      for (const r of pos) {
        for (const c of pos) {
          if (reserved[r][c]) continue;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const border = Math.max(Math.abs(dy), Math.abs(dx));
              setModule(r + dy, c + dx, border === 0 || border === 2 ? 1 : 0);
            }
          }
        }
      }
    }

    for (let i = 8; i < size - 8; i++) {
      if (!reserved[6][i]) setModule(6, i, i % 2 === 0 ? 1 : 0);
      if (!reserved[i][6]) setModule(i, 6, i % 2 === 0 ? 1 : 0);
    }
    setModule(size - 8, 8, 1);

    for (let i = 0; i < 9; i++) {
      if (!reserved[8][i]) reserved[8][i] = true;
      if (!reserved[i][8]) reserved[i][8] = true;
      if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = true;
      if (!reserved[size - 1 - i][8]) reserved[size - 1 - i] = true;
    }

    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let up = true;

    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right--;
      const colPairs = [right, right - 1];
      const rows = [];
      for (let r = 0; r < size; r++) rows.push(up ? size - 1 - r : r);
      up = !up;

      for (const r of rows) {
        for (const c of colPairs) {
          if (!reserved[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              const byteVal = codewords[Math.floor(bitIdx / 8)];
              bit = (byteVal >>> (7 - (bitIdx % 8))) & 1;
              bitIdx++;
            }
            if ((r + c) % 2 === 0) bit ^= 1; // Mask 0
            matrix[r][c] = bit;
          }
        }
      }
    }

    // Format Information (Mask 0, ECC Level M: 0b10000 -> 0x5412 XOR)
    const formatBits = [1,0,1,0,1,0,0,0,0,0,1,0,0,1,0];
    const fmtCoords1 = [
      [8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
      [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]
    ];
    const fmtCoords2 = [
      [size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],
      [8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]
    ];

    for (let i = 0; i < 15; i++) {
      const bit = formatBits[i];
      matrix[fmtCoords1[i][0]][fmtCoords1[i][1]] = bit;
      matrix[fmtCoords2[i][0]][fmtCoords2[i][1]] = bit;
    }

    return matrix;
  }

  function render(canvas, text, options = {}) {
    if (!canvas) return;
    const sizePx = options.size || 220;
    const margin = options.margin !== undefined ? options.margin : 2;
    const darkColor = options.dark || '#0f172a';
    const lightColor = options.light || '#ffffff';

    const verInfo = selectVersion(text.length);
    const codewords = encodeData(text, verInfo);
    const matrix = createMatrix(verInfo, codewords);
    const moduleCount = matrix.length;
    const totalCells = moduleCount + margin * 2;

    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = lightColor;
    ctx.fillRect(0, 0, sizePx, sizePx);

    const cellSize = sizePx / totalCells;
    ctx.fillStyle = darkColor;

    for (let r = 0; r < moduleCount; r++) {
      for (let c = 0; c < moduleCount; c++) {
        if (matrix[r][c] === 1) {
          const x = Math.round((c + margin) * cellSize);
          const y = Math.round((r + margin) * cellSize);
          const w = Math.ceil((c + margin + 1) * cellSize) - x;
          const h = Math.ceil((r + margin + 1) * cellSize) - y;
          ctx.fillRect(x, y, w, h);
        }
      }
    }
  }

  global.QRGenerator = { render };
})(window);
