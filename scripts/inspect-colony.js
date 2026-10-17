import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { cpus, platform, release } from 'node:os';
import { screenshotColors } from '../test/browser/helpers.js';

const output = resolve('artifacts');
const baseURL = process.env.AGENT_MAP_TEST_URL || 'http://127.0.0.1:3000';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  httpCredentials: { username: 'andre', password: process.env.AGENT_MAP_TEST_PASSWORD || 'demo' },
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const captures = [], frames = [];
const cdp = await context.newCDPSession(page);
cdp.on('Page.screencastFrame', async event => {
  if (frames.length < 300) frames.push({ bytes: Buffer.from(event.data, 'base64'), at: event.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
});

async function load(query) {
  await page.goto(`${baseURL}/${query}`);
  await page.waitForFunction(() => window.agentMap?.renderer?.stats?.().drawCalls > 0);
  await page.locator('#colony-world canvas[data-ready="true"]').waitFor();
}
async function capture(name) {
  const path = resolve(output, `${name}.png`);
  await page.screenshot({ path });
  const state = await page.evaluate(() => window.agentMap ? ({ mode: window.agentMap.state.mode,
    stats: window.agentMap.renderer?.stats?.(), agents: window.agentMap.state.agents.length,
    workItems: window.agentMap.state.workItems.length, sources: window.agentMap.state.sources }) : null);
  captures.push({ name, path, state });
  console.log(`Captured ${name}`);
}
async function selectFirst(type) {
  const id = await page.evaluate(key => window.agentMap.state[key][0]?.id, type);
  if (!id) throw new Error(`No ${type} to inspect`);
  await page.getByRole('button', { name: 'Explore colony', exact: true }).click();
  await page.locator(`[data-entity-id="${id}"]`).click();
  await page.locator('#details-card').waitFor();
  await page.waitForFunction(() => !window.agentMap?.renderer?.flight);
}

let measurement, framebuffer, graphics, video = { status: 'unavailable', reason: 'Not yet encoded' };
try {
  await load('?mode=demo&step=1');
  graphics = await page.evaluate(() => {
    const canvas = document.querySelector('#colony-world canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, dpr: devicePixelRatio,
      vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
  });
  await capture('colony-desktop');
  measurement = await page.evaluate(async () => {
    const stats = () => window.agentMap.renderer.stats();
    const startStats = stats(), start = performance.now(), deltas = [];
    let previous = start;
    for (let i = 0; i < 90 && performance.now() - start < 8000; i++) {
      const now = await new Promise(requestAnimationFrame);
      deltas.push(now - previous); previous = now;
    }
    const duration = performance.now() - start, endStats = stats();
    const sorted = deltas.slice(1).sort((a, b) => a - b);
    return { viewport: { width: innerWidth, height: innerHeight }, sampleFrames: deltas.length,
      durationMs: Math.round(duration), rafFPS: Math.round(deltas.length * 1000 / duration * 10) / 10,
      rendererFPS: Math.round((endStats.renderFrameCount - startStats.renderFrameCount) * 1000 / duration * 10) / 10,
      frameP50Ms: Math.round(sorted[Math.floor(sorted.length * 0.5)] * 10) / 10,
      frameP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10) / 10,
      stats: endStats };
  });
  framebuffer = screenshotColors(await page.locator('#colony-world canvas').screenshot());
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: 1280, maxHeight: 888, everyNthFrame: 2 });
  await selectFirst('agents');
  await capture('colony-selected-robot');
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.evaluate(() => window.agentMap.setDemoStep(2));
  await page.waitForTimeout(700);
  await page.evaluate(() => window.agentMap.setDemoStep(3));
  await page.waitForTimeout(700);
  await capture('colony-changes-requested');
  await page.evaluate(() => window.agentMap.setDemoStep(4));
  await page.waitForTimeout(700);
  await page.evaluate(() => window.agentMap.setDemoStep(5));
  await page.getByRole('button', { name: 'Needs Andre', exact: true }).click();
  await page.waitForTimeout(700);
  await capture('colony-waiting');
  await cdp.send('Page.stopScreencast');
  await load('?mode=demo&step=5&crowded=1');
  await capture('colony-crowded');
  await load('?mode=live');
  await capture('colony-live-quiet');
  await load('?mode=demo&step=5&stale=1');
  await capture('colony-stale');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load('?mode=demo&step=2');
  await capture('colony-reduced-motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  await load('?mode=demo&step=5');
  await capture('colony-mobile');
  await page.getByRole('button', { name: 'Needs Andre', exact: true }).click();
  await page.waitForFunction(() => !window.agentMap?.renderer?.flight);
  await capture('colony-mobile-waiting');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseURL}/2d?mode=demo`);
  await page.locator('.tile').first().waitFor();
  await capture('colony-2d-fallback');

  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    const path = resolve(output, 'colony-interaction.webm');
    const encoder = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', '12', '-i', 'pipe:0',
      '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M', '-pix_fmt', 'yuv420p', path],
    { stdio: ['pipe', 'ignore', 'pipe'] });
    let encoderError = '';
    encoder.stderr.on('data', chunk => { encoderError += chunk; });
    encoder.stdin.on('error', () => {});
    const completed = once(encoder, 'close');
    for (let i = 0; i < frames.length; i++) {
      const nextAt = frames[i + 1]?.at ?? frames[i].at + 0.2;
      const copies = Math.max(1, Math.min(24, Math.round((nextAt - frames[i].at) * 12)));
      for (let n = 0; n < copies; n++) if (!encoder.stdin.write(frames[i].bytes)) await once(encoder.stdin, 'drain');
    }
    encoder.stdin.end();
    const [code] = await completed;
    if (code !== 0) throw new Error(encoderError || `ffmpeg exited ${code}`);
    video = { status: 'recorded', path, capturedFrames: frames.length, encodingFPS: 12,
      note: 'CDP interaction capture; frame duration approximated at 12 FPS. This is not a performance measurement.' };
  } catch (error) { video = { status: 'unavailable', reason: error.message }; }
} finally {
  await cdp.detach().catch(() => {});
  await browser.close();
  const cpuQuota = await readFile('/sys/fs/cgroup/cpu.max', 'utf8').then(value => value.trim()).catch(() => null);
  const report = { capturedAt: new Date().toISOString(), environment: { platform: platform(), release: release(),
    cpu: cpus()[0]?.model, logicalCPUs: cpus().length, cpuQuota, browser: browser.version(), softwareRendering: true,
    note: 'Headless system Chromium with ANGLE SwiftShader in a cloud container. 390px captures are responsive layout checks; mobile hardware FPS is unmeasured.' },
  graphics, measurement, framebuffer, captures, video, applicationErrors: errors };
  await writeFile(resolve(output, 'inspection-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ measurement, graphics, video, applicationErrors: errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}
