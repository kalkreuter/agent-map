import { inflateSync } from 'node:zlib';
import { expect } from '@playwright/test';

// Inspect the actual compositor screenshot without introducing an image package.
// Chromium emits non-interlaced RGB/RGBA PNGs; reverse all standard PNG filters.
export function screenshotColors(png) {
  let width, height, channels, offset = 8;
  const imageChunks = [];
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || ![2, 6].includes(data[9]) || data[12] !== 0) throw new Error('Unsupported screenshot PNG');
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') imageChunks.push(data);
    offset += size + 12;
  }
  const bytes = inflateSync(Buffer.concat(imageChunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride), cursor = 0;
  const colors = new Set();
  let bright = 0, dark = 0, sampled = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = bytes[cursor++], row = Buffer.from(bytes.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0, b = previous[x], c = x >= channels ? previous[x - channels] : 0;
      row[x] = (row[x] + (filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : filter === 4 ? paeth(a, b, c) : 0)) & 255;
    }
    if (y % 5 === 0) for (let x = 0; x < width; x += 5) {
      const i = x * channels, r = row[i], g = row[i + 1], b = row[i + 2];
      colors.add(`${r >> 3},${g >> 3},${b >> 3}`);
      const luminosity = (r + g + b) / 3;
      bright += luminosity > 215 ? 1 : 0; dark += luminosity < 80 ? 1 : 0; sampled++;
    }
    previous = row;
  }
  return { width, height, colors: colors.size, bright, dark, sampled };
}

export async function waitForColony(page, path = '/?mode=demo&step=5') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(path);
  const canvas = page.locator('#colony-world canvas');
  await expect(canvas, 'A real WebGL scene is required; this check must fail if WebGL is unavailable').toBeVisible();
  await page.waitForFunction(() => window.agentMap?.renderer?.stats?.().drawCalls > 0);
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  const dimensions = await canvas.boundingBox();
  expect(dimensions.width).toBeGreaterThan(100);
  expect(dimensions.height).toBeGreaterThan(100);
  return { canvas, errors };
}

export async function selectEntity(page, type = 'agents') {
  const entity = await page.evaluate(key => window.agentMap.state[key][0], type);
  expect(entity, `Expected a selectable ${type} entity`).toBeTruthy();
  await page.getByRole('button', { name: 'Explore colony', exact: true }).click();
  await page.locator(`[data-entity-id="${entity.id}"]`).click();
  await expect(page.locator('#details-card')).toBeVisible();
  await expect(page.locator('#details-card')).toContainText(entity.name || entity.title);
  return entity;
}
