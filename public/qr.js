(function () {
  const PAD0 = 0xec;
  const PAD1 = 0x11;
  const BYTE_MODE = 0b0100;
  const VERSION = 3;
  const SIZE = 29;
  const DATA_CODEWORDS = 55;
  const EC_CODEWORDS = 15;
  const TOTAL_CODEWORDS = DATA_CODEWORDS + EC_CODEWORDS;

  const EXP_TABLE = new Array(512);
  const LOG_TABLE = new Array(256);

  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP_TABLE[i] = value;
    LOG_TABLE[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }

  for (let i = 255; i < 512; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }

  function gfMul(a, b) {
    if (a === 0 || b === 0) {
      return 0;
    }
    return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
  }

  function polyMultiply(a, b) {
    const result = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        result[i + j] ^= gfMul(a[i], b[j]);
      }
    }
    return result;
  }

  function createGeneratorPolynomial(degree) {
    let polynomial = [1];
    for (let i = 0; i < degree; i += 1) {
      polynomial = polyMultiply(polynomial, [1, EXP_TABLE[i]]);
    }
    return polynomial;
  }

  function createBitBuffer() {
    const bits = [];
    return {
      bits,
      put(value, length) {
        for (let i = length - 1; i >= 0; i -= 1) {
          bits.push((value >>> i) & 1);
        }
      },
      putBytes(bytes) {
        bytes.forEach((byte) => this.put(byte, 8));
      },
    };
  }

  function stringToUtf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function createCodewords(text) {
    const bytes = stringToUtf8Bytes(text);
    if (bytes.length > 53) {
      throw new Error("QR payload is too long for local generator.");
    }

    const buffer = createBitBuffer();
    buffer.put(BYTE_MODE, 4);
    buffer.put(bytes.length, 8);
    buffer.putBytes(bytes);

    const maxBits = DATA_CODEWORDS * 8;
    const remaining = maxBits - buffer.bits.length;
    buffer.put(0, Math.min(4, remaining));

    while (buffer.bits.length % 8 !== 0) {
      buffer.put(0, 1);
    }

    const data = [];
    for (let i = 0; i < buffer.bits.length; i += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        byte = (byte << 1) | buffer.bits[i + bit];
      }
      data.push(byte);
    }

    let toggle = true;
    while (data.length < DATA_CODEWORDS) {
      data.push(toggle ? PAD0 : PAD1);
      toggle = !toggle;
    }

    const generator = createGeneratorPolynomial(EC_CODEWORDS);
    const message = data.concat(new Array(EC_CODEWORDS).fill(0));
    for (let i = 0; i < data.length; i += 1) {
      const factor = message[i];
      if (factor === 0) {
        continue;
      }
      for (let j = 0; j < generator.length; j += 1) {
        message[i + j] ^= gfMul(generator[j], factor);
      }
    }

    return data.concat(message.slice(message.length - EC_CODEWORDS));
  }

  function createMatrix() {
    return Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  }

  function placeFinder(matrix, row, col) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = col + c;
        if (y < 0 || y >= SIZE || x < 0 || x >= SIZE) {
          continue;
        }

        const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
        const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y][x] = isBorder ? false : isOuter || isInner;
      }
    }
  }

  function placeTiming(matrix) {
    for (let i = 8; i < SIZE - 8; i += 1) {
      const value = i % 2 === 0;
      if (matrix[6][i] === null) {
        matrix[6][i] = value;
      }
      if (matrix[i][6] === null) {
        matrix[i][6] = value;
      }
    }
  }

  function placeAlignment(matrix, row, col) {
    for (let r = -2; r <= 2; r += 1) {
      for (let c = -2; c <= 2; c += 1) {
        const y = row + r;
        const x = col + c;
        if (matrix[y][x] !== null) {
          continue;
        }
        const dist = Math.max(Math.abs(r), Math.abs(c));
        matrix[y][x] = dist !== 1;
      }
    }
  }

  function reserveFormatInfo(matrix) {
    for (let i = 0; i < 9; i += 1) {
      if (i !== 6) {
        matrix[8][i] = false;
        matrix[i][8] = false;
      }
    }

    for (let i = 0; i < 8; i += 1) {
      matrix[SIZE - 1 - i][8] = false;
      matrix[8][SIZE - 1 - i] = false;
    }

    matrix[SIZE - 8][8] = true;
  }

  function placeDarkModule(matrix) {
    matrix[SIZE - 8][8] = true;
  }

  function getFormatBits(mask) {
    const format = (1 << 3) | mask;
    let bits = format << 10;
    const generator = 0b10100110111;
    for (let i = 14; i >= 10; i -= 1) {
      if ((bits >>> i) & 1) {
        bits ^= generator << (i - 10);
      }
    }
    const value = ((format << 10) | bits) ^ 0b101010000010010;
    return value;
  }

  function applyFormatInfo(matrix, mask) {
    const bits = getFormatBits(mask);
    const positionsA = [
      [8, 0],
      [8, 1],
      [8, 2],
      [8, 3],
      [8, 4],
      [8, 5],
      [8, 7],
      [8, 8],
      [7, 8],
      [5, 8],
      [4, 8],
      [3, 8],
      [2, 8],
      [1, 8],
      [0, 8],
    ];
    const positionsB = [
      [SIZE - 1, 8],
      [SIZE - 2, 8],
      [SIZE - 3, 8],
      [SIZE - 4, 8],
      [SIZE - 5, 8],
      [SIZE - 6, 8],
      [SIZE - 7, 8],
      [8, SIZE - 8],
      [8, SIZE - 7],
      [8, SIZE - 6],
      [8, SIZE - 5],
      [8, SIZE - 4],
      [8, SIZE - 3],
      [8, SIZE - 2],
      [8, SIZE - 1],
    ];

    for (let i = 0; i < 15; i += 1) {
      const bit = ((bits >>> (14 - i)) & 1) === 1;
      const [r1, c1] = positionsA[i];
      const [r2, c2] = positionsB[i];
      matrix[r1][c1] = bit;
      matrix[r2][c2] = bit;
    }
  }

  function placeData(matrix, codewords, mask) {
    const bits = [];
    codewords.forEach((byte) => {
      for (let bit = 7; bit >= 0; bit -= 1) {
        bits.push((byte >>> bit) & 1);
      }
    });

    let bitIndex = 0;
    let upward = true;

    for (let col = SIZE - 1; col > 0; col -= 2) {
      if (col === 6) {
        col -= 1;
      }

      for (let step = 0; step < SIZE; step += 1) {
        const row = upward ? SIZE - 1 - step : step;
        for (let offset = 0; offset < 2; offset += 1) {
          const currentCol = col - offset;
          if (matrix[row][currentCol] !== null) {
            continue;
          }

          let bit = bits[bitIndex] || 0;
          bitIndex += 1;
          if ((row + currentCol) % 2 === 0 && mask === 0) {
            bit ^= 1;
          }
          matrix[row][currentCol] = bit === 1;
        }
      }

      upward = !upward;
    }
  }

  function renderSvg(matrix) {
    const quiet = 4;
    const viewBox = SIZE + quiet * 2;
    const cells = [];

    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        if (matrix[row][col]) {
          cells.push(
            `<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1" />`
          );
        }
      }
    }

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" shape-rendering="crispEdges">`,
      '<rect width="100%" height="100%" fill="#ffffff"/>',
      '<g fill="#000000">',
      cells.join(""),
      "</g>",
      "</svg>",
    ].join("");
  }

  function generateQrDataUrl(text) {
    const matrix = createMatrix();
    placeFinder(matrix, 0, 0);
    placeFinder(matrix, 0, SIZE - 7);
    placeFinder(matrix, SIZE - 7, 0);
    placeTiming(matrix);
    placeAlignment(matrix, 22, 22);
    reserveFormatInfo(matrix);
    placeDarkModule(matrix);
    const codewords = createCodewords(text);
    placeData(matrix, codewords, 0);
    applyFormatInfo(matrix, 0);
    const svg = renderSvg(matrix);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }

  window.generateQrDataUrl = generateQrDataUrl;
})();
