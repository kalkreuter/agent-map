import { test, expect } from '@playwright/test';
import { screenshotColors, selectEntity, waitForColony } from './helpers.js';

function observedRecording(title = 'Recorded permission audit') {
  const at = '2026-10-15T15:00:00Z';
  return { mode: 'RECORDED', updatedAt: at,
    repos: [{ repo: 'owner/project', name: 'Recorded project', color: '#839ef3', updatedAt: at }],
    items: [{ kind: 'pr', id: 'owner/project#7', repo: 'owner/project', number: 7, title,
      state: 'WORKING', labels: [], dataComplete: true, headAt: at, headSha: 'a'.repeat(40),
      url: 'javascript:globalThis.__sourceExecuted=true', ci: { state: 'success' } }],
    states: { WORKING: { label: 'Working', symbol: '*', color: '#839ef3' } },
    errors: [], loading: false, pollMs: 60_000 };
}

function disableWebGL() {
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    return /^webgl|experimental-webgl/.test(type) ? null : original.call(this, type, ...rest);
  };
}

test('3D colony draws substantive geometry, receives a canvas selection, and opens relationships', async ({ page }) => {
  const { canvas, errors } = await waitForColony(page);
  const stats = await page.evaluate(() => window.agentMap.renderer.stats());
  expect(stats.districts).toBeGreaterThanOrEqual(2);
  expect(stats.workSites).toBeGreaterThan(0);
  expect(stats.robots).toBeGreaterThan(0);
  expect(stats.triangles).toBeGreaterThan(100);
  const colors = screenshotColors(await canvas.screenshot());
  expect(colors.colors, 'Rendered canvas must contain many real scene colors').toBeGreaterThan(80);
  expect(colors.bright, 'White modular buildings must appear in the framebuffer').toBeGreaterThan(20);
  await test.info().attach('colony-frame.png', { body: await page.screenshot(), contentType: 'image/png' });
  const target = await page.evaluate(() => {
    const entity = window.agentMap.state.workItems.find(item => item.id === 'demo:manage:access-audit') || window.agentMap.state.workItems[0];
    return { id: entity.id, name: entity.name || entity.title, point: window.agentMap.renderer.screenPosition(entity.id) };
  });
  expect(target.point).toBeTruthy();
  await page.mouse.click(target.point.x, target.point.y);
  await expect(page.locator('#details-card')).toBeVisible();
  await expect(page.locator('#details-card')).toContainText(target.name);
  const relatedIds = await page.evaluate(id => window.agentMap.state.relationships.filter(edge => edge.fromId === id || edge.toId === id).length, target.id);
  expect(relatedIds).toBeGreaterThan(0);
  await expect(page.locator('#card-related button').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('deterministic replay reaches approval without asserting a merge and restarts cleanly', async ({ page }) => {
  const { errors } = await waitForColony(page, '/?mode=demo&step=0');
  const initial = await page.evaluate(() => ({ projects: window.agentMap.state.projects.map(project => project.id),
    work: window.agentMap.state.workItems.map(item => item.id) }));
  await page.getByRole('button', { name: 'Next demo step', exact: true }).click();
  const travel = await page.evaluate(() => {
    const renderer = window.agentMap.renderer;
    const robot = [...renderer.robots.values()].find(entry => entry.waypoint < entry.path.length);
    if (!robot) return null;
    const position = robot.model.object.position.clone(), waypoint = robot.waypoint;
    // A queued rAF can predate an expensive WebGL constructor. It must never
    // reverse route movement or put a robot outside its walkable district.
    renderer.frame(renderer.lastFrame - 100);
    return { displacement: position.distanceTo(robot.model.object.position),
      waypointBefore: waypoint, waypointAfter: robot.waypoint };
  });
  expect(travel, 'The observed demo assignment must create a travelling robot').toBeTruthy();
  expect(travel.displacement).toBe(0);
  expect(travel.waypointAfter).toBeGreaterThanOrEqual(travel.waypointBefore);
  for (let step = 2; step <= 5; step++) {
    await page.getByRole('button', { name: 'Next demo step', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.agentMap.state.demoStep)).toBe(step);
  }
  const replay = await page.evaluate(() => window.agentMap.state);
  expect(replay.projects.map(project => project.id)).toEqual(initial.projects);
  expect(replay.workItems.map(item => item.id)).toEqual(initial.work);
  expect(new Set(replay.agents.map(agent => agent.id)).size).toBe(replay.agents.length);
  expect(new Set(replay.events.map(event => event.id)).size).toBe(replay.events.length);
  expect(replay.workItems.some(item => item.status === 'merged' || item.status === 'deployed')).toBe(false);
  expect(replay.workItems.filter(item => item.status === 'waiting')).toHaveLength(1);
  await expect(page.locator('#needs-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Restart demo replay', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.agentMap.state.demoStep)).toBe(0);
  await expect(page.locator('#needs-count')).toHaveText('0');
  expect(errors).toEqual([]);
});

test('keyboard item navigation opens a robot card and preserves focus on close', async ({ page }) => {
  const { errors } = await waitForColony(page);
  const entity = await selectEntity(page);
  await expect(page.locator('#details-card')).toContainText(/observed|source|demo/i);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.locator('#details-card')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Explore colony', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Explore colony', exact: true }).click();
  await page.locator(`[data-entity-id="${entity.id}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#details-card')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Needs Andre is derived from explicit waiting work and has previous/next navigation', async ({ page }) => {
  await waitForColony(page);
  const waiting = await page.evaluate(() => window.agentMap.state.workItems.filter(item => item.status === 'waiting' && item.waitingReason).length);
  expect(waiting).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Needs Andre', exact: true }).click();
  await expect(page.locator('#details-card')).toBeVisible();
  await expect(page.locator('#details-card')).toContainText(/Andre|approval/i);
  await page.getByRole('button', { name: 'Next waiting', exact: true }).click();
  await page.getByRole('button', { name: 'Previous waiting', exact: true }).click();
  await expect(page.locator('#details-card')).toBeVisible();
  await expect(page.locator('#details-card').getByRole('button', { name: /^Approve|Merge|Deploy$/i })).toHaveCount(0);
});

test('dragging the world stops following and updates the follow control', async ({ page }) => {
  const { errors } = await waitForColony(page);
  const entity = await selectEntity(page);
  const follow = page.locator('#follow-agent');
  await follow.click();
  await expect(follow).toHaveText('Stop following');
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.agentMap.renderer.followId)).toBe(entity.id);
  await page.mouse.move(650, 530);
  await page.mouse.down();
  await page.mouse.move(710, 560, { steps: 5 });
  await page.mouse.up();
  await expect(follow).toHaveText('Follow robot');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => window.agentMap.renderer.followId)).toBe(null);
  expect(errors).toEqual([]);
});

test('live mode stays quiet and contains no synthetic runs', async ({ page }) => {
  const { errors } = await waitForColony(page, '/?mode=live');
  const state = await page.evaluate(() => window.agentMap.state);
  expect(state.mode).toBe('LIVE');
  expect(state.agents).toHaveLength(0);
  expect(state.workItems).toHaveLength(0);
  expect(state.events.every(event => event.provenance !== 'demo')).toBe(true);
  await expect.poll(() => page.evaluate(() => window.agentMap.renderer.stats().paused)).toBe(true);
  const frames = await page.evaluate(() => window.agentMap.renderer.stats().renderFrameCount);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.agentMap.renderer.stats().renderFrameCount)).toBe(frames);
  await page.getByRole('button', { name: 'Needs Andre', exact: true }).click();
  await expect(page.locator('body')).toContainText('Nothing explicitly needs Andre right now');
  expect(errors).toEqual([]);
});

test('crowded and stale fixtures remain selectable and disclose source freshness', async ({ page }) => {
  const { errors } = await waitForColony(page, '/?mode=demo&step=5&crowded=1&stale=1');
  const state = await page.evaluate(() => window.agentMap.state);
  expect(state.agents.length).toBeGreaterThan(8);
  expect(state.sources.some(source => source.status === 'stale')).toBe(true);
  await expect(page.locator('body')).toContainText(/stale/i);
  await selectEntity(page);
  await test.info().attach('crowded-stale.png', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('390px viewport keeps camera and accessible selection controls usable with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { canvas, errors } = await waitForColony(page);
  const motion = await page.evaluate(() => window.agentMap.renderer.stats());
  expect(motion.reducedMotion).toBe(true);
  expect(motion.pixelRatio).toBeLessThanOrEqual(1.6);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(horizontalOverflow).toBe(false);
  await selectEntity(page, 'workItems');
  const card = await page.locator('#details-card').boundingBox();
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(391);
  expect(card.height).toBeLessThan(844 * 0.7);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox.height).toBeGreaterThan(300);
  await test.info().attach('mobile-selection.png', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors).toEqual([]);
});

test('WebGL initialization failure automatically opens the working 2D fallback', async ({ page }) => {
  await page.addInitScript(disableWebGL);
  await page.goto('/?mode=demo&step=5');
  await expect(page).toHaveURL(/\/2d(?:\?|$)/);
  await expect(page.locator('#viewport')).toBeVisible();
  await expect(page.locator('.tile').first()).toBeVisible();
});

test('lost WebGL context offers fallback and disposal stops new frames', async ({ page }) => {
  await waitForColony(page);
  await page.evaluate(() => {
    window.__disposedRenderer = window.agentMap.renderer;
    window.agentMap.dispose();
  });
  const before = await page.evaluate(() => window.__disposedRenderer.stats());
  expect(before.disposed).toBe(true);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.__disposedRenderer.stats());
  expect(after.renderFrameCount).toBe(before.renderFrameCount);
  await page.reload();
  await page.waitForFunction(() => window.agentMap?.renderer?.stats?.().drawCalls > 0);
  await page.evaluate(() => {
    const canvas = document.querySelector('#colony-world canvas');
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  });
  await expect(page).toHaveURL(/\/2d(?:\?|$)/);
  await expect(page.locator('.tile').first()).toBeVisible();
});

test('recorded source text remains inert and unsafe source links are omitted', async ({ page }) => {
  const errors = [], liveRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/map') liveRequests.push(request.url()); });
  await page.goto('/?mode=recorded');
  const title = '<img src=x onerror="globalThis.__sourceExecuted=true"> Untrusted PR';
  const at = '2026-10-15T15:00:00Z';
  const recording = observedRecording(title);
  await page.locator('#recording-file').setInputFiles({ name: 'untrusted-recording.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(recording)) });
  await page.waitForFunction(() => window.agentMap?.state?.workItems.length === 1);
  await selectEntity(page, 'workItems');
  await expect(page.locator('#card-title')).toHaveText(title);
  await expect(page.locator('#details-card img')).toHaveCount(0);
  await expect(page.locator('#source-link')).toBeHidden();
  expect(await page.evaluate(() => Boolean(globalThis.__sourceExecuted))).toBe(false);
  expect(await page.evaluate(() => window.agentMap.state.observedAt)).toBe(at);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await page.locator('#flat-link').click();
  await expect(page.locator('#recorded-flat-map .tile').first()).toBeVisible();
  expect(await page.evaluate(() => window.agentMap.state.mode)).toBe('RECORDED');
  expect(await page.evaluate(() => window.agentMap.state.observedAt)).toBe(at);
  expect(liveRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('recorded observations automatically fall back to 2D without fetching live data', async ({ page }) => {
  const errors = [], liveRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/map') liveRequests.push(request.url()); });
  await page.addInitScript(disableWebGL);
  await page.goto('/?mode=recorded');
  await expect(page.locator('#recorded-flat-map')).toBeVisible();
  const recording = observedRecording();
  await page.locator('#recording-file').setInputFiles({ name: 'recording.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(recording)) });
  await expect(page.locator('#recorded-flat-map .tile').first()).toBeVisible();
  expect(await page.evaluate(() => window.agentMap.state.mode)).toBe('RECORDED');
  expect(await page.evaluate(() => window.agentMap.state.observedAt)).toBe(recording.updatedAt);
  await selectEntity(page, 'workItems');
  await expect(page.locator('#card-title')).toHaveText(recording.items[0].title);
  expect(liveRequests).toEqual([]);
  expect(errors).toEqual([]);
});
