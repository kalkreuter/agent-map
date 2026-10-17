import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { normalizeSnapshot, needsAndre, cycleWaiting } from '../public/scene-state.js';
import { demoState } from '../public/demo-state.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');

// Model only the DOM operations used by app.js; the map renderer is a separate boundary.
class Element {
  children = []; dataset = {}; style = {}; hidden = false; value = ''; _text = '';
  get options() { return this.children; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  add(child) { this.append(child); }
  replaceChildren(...children) { this.children = children; this._text = ''; }
  addEventListener() {}
  querySelectorAll() { return []; }
  removeAttribute(name) { delete this[name]; }
}

function snapshot() {
  return { repos: [{ repo: 'owner/one', name: 'One', color: '#123456' }, { repo: 'owner/two', name: 'Two', color: '#abcdef' }],
    states: { NEEDS_ANDRE: { label: 'Needs Andre', color: '#ff747d', symbol: '?' },
      DEPLOY_UNVERIFIED: { label: 'Live / unverified', color: '#f4bb65', symbol: '?' } },
    items: [], errors: [], loading: false, updatedAt: '2026-10-16T12:00:00Z', pollMs: 60_000 };
}

async function loadApp(initial = snapshot()) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const document = { getElementById: id => elements.get(id) ?? null, createElement: () => new Element(),
    createTextNode: value => { const node = new Element(); node.textContent = value; return node; }, addEventListener() {} };
  let current = initial;
  const context = createContext({ document, URL, AbortSignal, normalizeSnapshot, needsAndre, cycleWaiting, demoState, setTimeout: () => 1, clearTimeout() {},
    Option: class extends Element { constructor(label, value) { super(); this.textContent = label; this.value = value; } },
    HexMap: class { setItems() {} select() {} fit() {} zoom() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => current }) });
  for (const element of elements.values()) element.focus = () => { document.activeElement = element; };
  runInContext(app, context);
  // Let the actual startup poll finish before exercising subsequent polls.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('notice').hidden, true, elements.get('notice').textContent);
  return { element: id => elements.get(id), context, document,
    async poll(data) {
      current = data; await context.poll();
      assert.equal(elements.get('notice').hidden, true, elements.get('notice').textContent);
    } };
}

test('ordinary snapshot polling preserves filter option and legend nodes while a filter is active', async () => {
  const ui = await loadApp(), repo = ui.element('repo-filter'), state = ui.element('state-filter');
  repo.value = 'owner/two'; state.value = 'DEPLOY_UNVERIFIED'; repo.focus();
  const repoOptions = [...repo.options], stateOptions = [...state.options], legend = [...ui.element('legend').children];
  const updated = snapshot();
  updated.updatedAt = '2026-10-16T12:01:00Z'; updated.repos[0].updatedAt = updated.updatedAt; updated.repos[0].stale = true;
  // Object property order is not a displayed configuration change.
  updated.states = Object.fromEntries(Object.entries(updated.states).map(([id, value]) => [id,
    { symbol: value.symbol, color: value.color, label: value.label }]));
  await ui.poll(updated);
  repoOptions.forEach((option, index) => assert.equal(repo.options[index], option));
  stateOptions.forEach((option, index) => assert.equal(state.options[index], option));
  legend.forEach((entry, index) => assert.equal(ui.element('legend').children[index], entry));
  assert.equal(repo.value, 'owner/two'); assert.equal(state.value, 'DEPLOY_UNVERIFIED');
  assert.equal(ui.document.activeElement, repo);
});

test('changed project/state descriptors refresh controls and retain existing filter values', async t => {
  for (const [name, change, verify] of [
    ['project name', data => { data.repos[1].name = 'Renamed'; }, ui => assert.equal(ui.element('repo-filter').options[2].textContent, 'Renamed')],
    ['project color', data => { data.repos[1].color = '#fedcba'; }, () => {}],
    ['state label', data => { data.states.DEPLOY_UNVERIFIED.label = 'Unverified live'; }, ui => assert.equal(ui.element('state-filter').options[2].textContent, 'Unverified live')],
    ['state color', data => { data.states.DEPLOY_UNVERIFIED.color = '#ffaa00'; }, ui => assert.equal(ui.element('legend').children[1].children[0].style.backgroundColor, '#ffaa00')],
    ['state symbol', data => { data.states.DEPLOY_UNVERIFIED.symbol = '!'; }, () => {}],
  ]) await t.test(name, async () => {
    const ui = await loadApp(), repo = ui.element('repo-filter'), state = ui.element('state-filter');
    repo.value = 'owner/two'; state.value = 'DEPLOY_UNVERIFIED';
    const previousRepoOption = repo.options[2], previousStateOption = state.options[2];
    const updated = snapshot(); change(updated); await ui.poll(updated);
    assert.notEqual(repo.options[2], previousRepoOption); assert.notEqual(state.options[2], previousStateOption);
    assert.equal(repo.value, 'owner/two'); assert.equal(state.value, 'DEPLOY_UNVERIFIED'); verify(ui);
  });
});

test('configuration order updates are reflected and removed filter values fall back to all items', async () => {
  const ui = await loadApp(), repo = ui.element('repo-filter'), state = ui.element('state-filter');
  repo.value = 'owner/two'; state.value = 'DEPLOY_UNVERIFIED';
  const reordered = snapshot(); reordered.repos.reverse(); reordered.states = Object.fromEntries(Object.entries(reordered.states).reverse());
  await ui.poll(reordered);
  assert.equal(repo.options[1].value, 'owner/two'); assert.equal(state.options[1].value, 'DEPLOY_UNVERIFIED');
  assert.equal(repo.value, 'owner/two'); assert.equal(state.value, 'DEPLOY_UNVERIFIED');
  const removed = snapshot(); removed.repos.pop(); delete removed.states.DEPLOY_UNVERIFIED;
  await ui.poll(removed);
  assert.equal(repo.value, ''); assert.equal(state.value, '');
});

test('deployment cards offer the Railway console and clear external links when changing card types', async () => {
  const data = snapshot(), version = { id: 'live', status: 'SUCCESS', sha: null, createdAt: data.updatedAt, url: null };
  const deployment = { kind: 'deployment', id: 'railway:project:environment:service', repo: 'owner/one', title: 'Production web',
    state: 'DEPLOY_UNVERIFIED', environmentName: 'production', serviceName: 'web', branch: 'main',
    url: 'https://railway.com/project/project/service/service?environmentId=environment', collectedAt: data.updatedAt,
    deployment: { status: 'SUCCESS', live: version, latest: version }, sync: { status: 'unknown', branch: 'main', headSha: null } };
  const pr = { kind: 'pr', id: 'owner/one#1', repo: 'owner/one', number: 1, title: 'A pull request', state: 'NEEDS_ANDRE',
    headSha: 'a'.repeat(40), headAt: data.updatedAt, ci: { state: 'success' }, url: 'https://github.com/owner/one/pull/1' };
  data.items.push(deployment, pr);
  const ui = await loadApp(data);
  assert.equal(ui.element('open-deployment'), undefined);
  ui.context.openCard(deployment.id);
  assert.equal(ui.element('open-railway').hidden, false); assert.equal(ui.element('open-railway').href, deployment.url);
  assert.equal(ui.element('open-pr').hidden, true); assert.equal(ui.element('open-agent').hidden, true);
  assert.match(ui.element('card-state').textContent, /Live \/ unverified/);
  assert.match(ui.element('card-deployment-facts').textContent, /Unknown — comparison with main is unverified/);
  ui.context.openCard(pr.id);
  assert.equal(ui.element('open-railway').hidden, true); assert.equal(ui.element('open-railway').href, undefined);
  assert.equal(ui.element('open-pr').hidden, false); assert.equal(ui.element('open-pr').href, pr.url);
  deployment.url = 'https://railway.com.untrusted.test/project/project';
  ui.context.openCard(deployment.id);
  assert.equal(ui.element('open-railway').hidden, true); assert.equal(ui.element('open-railway').href, undefined);
  assert.equal(ui.element('open-pr').hidden, true); assert.equal(ui.element('open-pr').href, undefined);
});
