// Renderer boundary: setItems(items, repos, states), select(id), fit(), zoom().
// No GitHub knowledge or state classification belongs in this module.
const NS = 'http://www.w3.org/2000/svg';
const R = 65;
function svgElement(tag, attrs = {}, content) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  if (content !== undefined) element.textContent = content;
  return element;
}
function hexPoints(x, y) {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (60 * i - 30) * Math.PI / 180;
    return `${x + (R - 4) * Math.cos(angle)},${y + (R - 4) * Math.sin(angle)}`;
  }).join(' ');
}
function coordinates(count) {
  const result = [];
  for (let ring = 0; result.length < count; ring++) {
    for (let q = -ring; q <= ring; q++) {
      for (let r = -ring; r <= ring; r++) {
        if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === ring) result.push({ q, r });
      }
    }
  }
  return result.slice(0, count).map(({ q, r }) => ({ x: R * Math.sqrt(3) * (q + r / 2), y: R * 1.5 * r }));
}
function clipped(value, length) {
  const words = String(value ?? '').replace(/\s+/g, ' ').trim();
  return words.length > length ? `${words.slice(0, length - 1)}…` : words;
}

export class HexMap {
  constructor(svg, viewport, onSelect) {
    this.svg = svg; this.viewport = viewport; this.onSelect = onSelect;
    this.scale = 1; this.x = 0; this.y = 0; this.pointers = new Map();
    this.bounds = { x: -200, y: -150, width: 400, height: 300 };
    svg.addEventListener('wheel', event => {
      event.preventDefault(); this.zoom(Math.exp(-event.deltaY * .002), this.local(event));
    }, { passive: false });
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      this.pointers.set(event.pointerId, this.local(event));
      this.start = this.local(event); this.dragged = false;
      this.tile = event.target.closest('.tile');
      svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!this.pointers.has(event.pointerId)) return;
      const before = [...this.pointers.values()];
      const point = this.local(event);
      const old = this.pointers.get(event.pointerId);
      this.pointers.set(event.pointerId, point);
      if (Math.hypot(point.x - this.start.x, point.y - this.start.y) > 5 || this.pointers.size > 1) this.dragged = true;
      if (this.pointers.size === 2) {
        const after = [...this.pointers.values()];
        const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        const center = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
        const a = center(before), b = center(after);
        this.zoom(distance(after) / Math.max(1, distance(before)), a);
        this.x += b.x - a.x; this.y += b.y - a.y;
      } else { this.x += point.x - old.x; this.y += point.y - old.y; }
      this.transform();
    });
    const end = event => {
      const wasPinching = this.pointers.size > 1;
      this.pointers.delete(event.pointerId);
      if (event.type === 'pointerup' && !wasPinching && !this.dragged && this.tile) this.onSelect(this.tile.dataset.id);
      if (wasPinching) this.dragged = true;
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('keydown', event => {
      const tile = event.target.closest('.tile');
      if (tile && ['Enter', ' '].includes(event.key)) { event.preventDefault(); this.onSelect(tile.dataset.id); }
    });
    this.observer = new ResizeObserver(() => this.fit()); this.observer.observe(svg);
  }
  local(event) { const rect = this.svg.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  transform() { this.viewport.setAttribute('transform', `translate(${this.x} ${this.y}) scale(${this.scale})`); }
  zoom(factor, point = { x: this.svg.clientWidth / 2, y: this.svg.clientHeight / 2 }) {
    const scale = Math.min(3, Math.max(.15, this.scale * factor));
    const ratio = scale / this.scale;
    this.x = point.x - (point.x - this.x) * ratio; this.y = point.y - (point.y - this.y) * ratio;
    this.scale = scale; this.transform();
  }
  fit() {
    const b = this.bounds, width = this.svg.clientWidth, height = this.svg.clientHeight;
    this.scale = Math.min(1.25, Math.max(.15, Math.min((width - 60) / b.width, (height - 95) / b.height)));
    this.x = width / 2 - (b.x + b.width / 2) * this.scale;
    this.y = (height - 30) / 2 - (b.y + b.height / 2) * this.scale;
    this.transform();
  }
  select(id) {
    for (const tile of this.viewport.querySelectorAll('.tile')) {
      tile.classList.toggle('selected', tile.dataset.id === id);
      tile.setAttribute('aria-pressed', String(tile.dataset.id === id));
    }
  }
  setItems(items, repos, states, fit = true) {
    const focusedId = this.viewport.contains(document.activeElement) ? document.activeElement.closest('.tile')?.dataset.id : null;
    this.viewport.replaceChildren();
    const clusters = repos.map(repo => ({ ...repo, items: items.filter(item => item.repo === repo.repo) }))
      .filter(repo => repo.items.length);
    let offsetX = 0;
    let minY = 0, maxY = 0;
    for (const repo of clusters) {
      const positions = coordinates(repo.items.length);
      const xs = positions.map(point => point.x), ys = positions.map(point => point.y);
      const left = Math.min(...xs) - R, right = Math.max(...xs) + R;
      const top = Math.min(...ys) - R, bottom = Math.max(...ys) + R;
      const origin = offsetX - left;
      const group = svgElement('g');
      const prCount = repo.items.filter(item => item.kind !== 'agent' && item.kind !== 'deployment').length;
      const agentCount = repo.items.filter(item => item.kind === 'agent').length;
      const deploymentCount = repo.items.filter(item => item.kind === 'deployment').length;
      const countLabel = `${prCount} PR${prCount === 1 ? '' : 'S'}${agentCount ? ` · ${agentCount} AGENT${agentCount === 1 ? '' : 'S'}` : ''}${deploymentCount ? ` · ${deploymentCount} DEPLOY${deploymentCount === 1 ? '' : 'S'}` : ''}${repo.stale ? ' · STALE' : ''}`;
      group.append(svgElement('text', { x: offsetX, y: top - 44, fill: repo.color, class: 'cluster-label' }, repo.name.toUpperCase()),
        svgElement('text', { x: offsetX, y: top - 24, class: 'cluster-count' }, countLabel));
      repo.items.forEach((item, index) => {
        const point = positions[index], x = origin + point.x, y = point.y;
        const state = states[item.state] ?? { color: '#8a95a9', symbol: '?', label: 'Unknown' };
        const isDeployment = item.kind === 'deployment';
        const label = isDeployment ? 'DEPLOY' : item.kind === 'agent' ? 'AGENT' : `#${item.number}`;
        const title = isDeployment ? `${item.environmentName || 'Unknown environment'} / ${item.serviceName || item.title}` : item.title;
        const tile = svgElement('g', { class: `tile ${item.state}`, tabindex: '0', role: 'button', 'data-id': item.id,
          'aria-label': `${repo.name}, ${label}: ${title}. ${state.label}${item.stale ? '. Stale data' : ''}`, 'aria-pressed': 'false' });
        if (state.fadeMs && item.mergedAt) tile.setAttribute('opacity', Math.max(.3, 1 - Math.max(0, Date.now() - Date.parse(item.mergedAt)) / state.fadeMs));
        tile.append(svgElement('title', {}, `${label} ${title} — ${state.label}${item.stale ? ' · Stale data' : ''}`),
          svgElement('polygon', { points: hexPoints(x, y), class: 'hex', fill: state.color, 'fill-opacity': '.07', stroke: state.color, 'stroke-opacity': '.6' }),
          svgElement('line', { x1: x - 15, x2: x + 15, y1: y + 49, y2: y + 49, stroke: repo.color, class: 'repo-edge' }),
          svgElement('text', { x, y: y - 25, 'text-anchor': 'middle', fill: state.color, class: 'tile-symbol' }, state.symbol),
          svgElement('text', { x, y: y - 3, 'text-anchor': 'middle', class: 'tile-number' }, label));
        const words = isDeployment ? `${clipped(item.environmentName || 'unknown', 8)} / ${clipped(item.serviceName || item.title, 10)}` : clipped(item.title, 17);
        tile.append(svgElement('text', { x, y: y + 16, 'text-anchor': 'middle', class: 'tile-title' }, words),
          svgElement('text', { x, y: y + 30, 'text-anchor': 'middle', class: 'tile-title' }, item.draft ? 'DRAFT' : clipped(state.label.toUpperCase(), 22)));
        group.append(tile);
      });
      this.viewport.append(group);
      minY = Math.min(minY, top - 60); maxY = Math.max(maxY, bottom);
      offsetX += Math.max(right - left, repo.name.length * 10, countLabel.length * 7) + 95;
    }
    this.bounds = { x: 0, y: minY, width: Math.max(300, offsetX - 95), height: Math.max(200, maxY - minY) };
    if (fit) this.fit();
    if (focusedId) [...this.viewport.querySelectorAll('.tile')].find(tile => tile.dataset.id === focusedId)?.focus({ preventScroll: true });
  }
}
