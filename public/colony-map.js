import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';
import { ColonyAssets } from './colony-assets.js';
import { createRobot } from './robot-model.js';

const FLOOR = .322;
const MAX_ROBOTS = 36;
const SITES = [
  { x: -2.5, z: .2, angle: -Math.PI / 2 },
  { x: 2.45, z: .45, angle: Math.PI / 2 },
  { x: 0, z: 2.3, angle: 0 },
  { x: 1.8, z: -2.45, angle: Math.PI / 2 },
];
const STATUS_COLORS = { working: '#58a9af', reviewing: '#8e85c0', waiting: '#e4ad4c', changes_requested: '#cb7664', failed: '#c97061', completed: '#78a482', merged: '#7083b1', deployed: '#5d9e91', idle: '#93a59c', unknown: '#9ba6a4', stale: '#9ba6a4' };
const hash = value => { let h = 2166136261; for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const safeColor = value => /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value || '') ? value : '#808dab';
const hexInside = (x, z, margin = .2) => Math.abs(x) < Math.sqrt(3) * 2.5 - margin && Math.abs(z) < 5 - margin && Math.abs(x) < Math.sqrt(3) * (5 - Math.abs(z)) - margin;
const axial = index => {
  if (!index) return { q: 0, r: 0 };
  const result = [{ q: -1, r: 0 }, { q: 0, r: 1 }, { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 1 }];
  if (index <= result.length) return result[index - 1];
  let count = result.length;
  for (let ring = 2; ring < 40; ring++) for (let q = -ring; q <= ring; q++) for (let r = -ring; r <= ring; r++) {
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) !== ring) continue;
    if (++count === index) return { q, r };
  }
  return { q: index, r: 0 };
};

export class ColonyMap {
  constructor(container, onSelect = () => {}, onFailure = () => {}) {
    this.container = container; this.onSelect = onSelect; this.onFailure = onFailure;
    this.disposed = false; this.contextLost = false; this.renderFrameCount = 0;
    this.entities = new Map(); this.districts = new Map(); this.sites = new Map(); this.robots = new Map();
    this.projectSlots = new Map(); this.siteSlots = new Map(); this.agentSlots = new Map(); this.seenEvents = new Set();
    this.assets = new ColonyAssets(); this.labelEntries = []; this.selectedId = null; this.followId = null;
    this.reducedQuery = matchMedia('(prefers-reduced-motion: reduce)'); this.reducedMotion = this.reducedQuery.matches;
    this.onReduced = () => { this.reducedMotion = this.reducedQuery.matches; this.flight = null; this.invalidate(); };
    this.reducedQuery.addEventListener('change', this.onReduced);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      const gl = this.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
      const rendererName = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '';
      this.softwareRendering = /swiftshader|llvmpipe|software rasterizer|software adapter/i.test(rendererName);
      this.assets.lowPower = this.softwareRendering;
      this.quality = this.softwareRendering ? 'reduced' : innerWidth <= 600 ? 'compact' : 'standard';
      this.renderer.setPixelRatio(this.quality === 'reduced' ? .75 : Math.min(window.devicePixelRatio || 1, this.quality === 'compact' ? 1.25 : 1.6));
      this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.autoUpdate = false; this.renderer.shadowMap.needsUpdate = true; this.renderer.shadowMap.type = this.softwareRendering ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15;
    } catch (error) { this.assets.dispose(); this.reducedQuery.removeEventListener('change', this.onReduced); throw error; }
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', 'Interactive agent colony. Use the item list for keyboard navigation.');
    this.canvas.setAttribute('role', 'img'); this.canvas.dataset.testid = 'colony-canvas';
    this.canvas.style.display = 'block'; this.canvas.style.width = '100%'; this.canvas.style.height = '100%'; this.canvas.style.touchAction = 'none';
    container.append(this.canvas);
    this.labelLayer = document.createElement('div'); this.labelLayer.className = 'colony-label-layer';
    Object.assign(this.labelLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    container.append(this.labelLayer);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#a8b89a');
    this.scene.fog = new THREE.Fog('#a8b89a', 48, 100);
    this.camera = new THREE.OrthographicCamera(-15, 15, 11, -11, .1, 130);
    this.camera.position.set(19, 24, 26); this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(0, .3, 0); this.controls.enableDamping = true; this.controls.dampingFactor = .09;
    this.controls.minPolarAngle = .35; this.controls.maxPolarAngle = 1.05;
    this.controls.minZoom = .2; this.controls.maxZoom = 3.5; this.controls.enablePan = true;
    this.controls.screenSpacePanning = false; this.controls.panSpeed = .8; this.controls.rotateSpeed = .5;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    this.onControlStart = () => { this.flight = null; const wasFollowing = !!this.followId; this.followId = null; if (wasFollowing) this.container.dispatchEvent(new Event('colony-follow-stopped')); this.invalidate(); };
    this.onControlChange = () => { this.clampCameraTarget(); this.invalidate(); };
    this.controls.addEventListener('start', this.onControlStart); this.controls.addEventListener('change', this.onControlChange);
    this.scene.add(new THREE.HemisphereLight('#e8f5ff', '#82906f', 2.45));
    const sunlight = new THREE.DirectionalLight('#fff1d5', 3.1); sunlight.position.set(-15, 25, 12); sunlight.castShadow = true;
    sunlight.shadow.mapSize.set(this.quality === 'standard' ? 2048 : 1024, this.quality === 'standard' ? 2048 : 1024); sunlight.shadow.camera.left = -28; sunlight.shadow.camera.right = 28;
    sunlight.shadow.camera.top = 28; sunlight.shadow.camera.bottom = -28; sunlight.shadow.camera.near = 1; sunlight.shadow.camera.far = 65;
    sunlight.shadow.normalBias = .04; sunlight.shadow.bias = -.0001; sunlight.shadow.radius = 3;
    this.scene.add(sunlight); this.sunlight = sunlight;
    const fill = new THREE.DirectionalLight('#d2e8f4', .5); fill.position.set(15, 8, -10); this.scene.add(fill);
    this.ground = this.assets.cylinder(70, 70, .15, '#819f68', 96); this.ground.position.y = -.26; this.ground.castShadow = false; this.scene.add(this.ground);
    this.world = new THREE.Group(); this.scene.add(this.world);
    this.nature = new THREE.Group(); this.scene.add(this.nature);
    this.selectionRing = this.makeSelectionRing(); this.scene.add(this.selectionRing); this.selectionRing.visible = false;
    this.connections = new THREE.Group(); this.scene.add(this.connections);
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.onPointerDown = event => { this.pointerStart = { x: event.clientX, y: event.clientY }; };
    this.onPointerUp = event => {
      if (!this.pointerStart || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 7 || event.button !== 0) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      for (const hit of this.raycaster.intersectObject(this.world, true)) {
        let object = hit.object;
        while (object && !object.userData.entityId) object = object.parent;
        if (object?.userData.entityId) { this.onSelect(object.userData.entityId); return; }
      }
    };
    this.onPointerMove = event => {
      if (event.buttons) return;
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      this.canvas.style.cursor = this.raycaster.intersectObject(this.world, true).length ? 'pointer' : 'grab';
    };
    this.onContextLost = event => { event.preventDefault(); this.contextLost = true; cancelAnimationFrame(this.raf); this.onFailure(new Error('The 3D graphics context was lost. The 2D map remains available.')); };
    this.onVisibility = () => { if (document.hidden) { cancelAnimationFrame(this.raf); this.raf = 0; } else { this.lastFrame = performance.now(); this.schedule(); } };
    this.canvas.addEventListener('pointerdown', this.onPointerDown); this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointermove', this.onPointerMove); this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container);
    this.resize(); this.needsRender = true; this.lastFrame = performance.now(); this.schedule();
  }

  makeSelectionRing() {
    const geometry = new THREE.RingGeometry(.44, .49, 48); geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({ color: '#f9f1c9', transparent: true, opacity: .95, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material); mesh.userData.ownedResource = true; mesh.renderOrder = 2; return mesh;
  }
  invalidate() { this.needsRender = true; this.schedule(); }
  resize() {
    if (this.disposed) return;
    const { width, height } = this.container.getBoundingClientRect();
    if (!width || !height) return;
    this.width = width; this.height = height; this.renderer.setSize(width, height, false);
    const aspect = width / height, size = 11;
    this.camera.left = -size * aspect; this.camera.right = size * aspect; this.camera.top = size; this.camera.bottom = -size;
    this.camera.updateProjectionMatrix(); this.invalidate();
  }
  clampCameraTarget() {
    const bound = this.worldBounds || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    const old = this.controls.target.clone();
    this.controls.target.x = THREE.MathUtils.clamp(old.x, bound.minX - 5, bound.maxX + 5);
    this.controls.target.z = THREE.MathUtils.clamp(old.z, bound.minZ - 5, bound.maxZ + 5);
    this.controls.target.y = .3;
    this.camera.position.add(this.controls.target.clone().sub(old));
  }
  addLabel(id, text, position, className = 'colony-label') {
    const button = document.createElement('button'); button.type = 'button'; button.className = className;
    button.textContent = text; button.dataset.id = id; button.setAttribute('aria-label', `Select ${text}`);
    button.addEventListener('click', () => this.onSelect(id));
    Object.assign(button.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'auto' });
    this.labelLayer.append(button); const entry = { element: button, position, id }; this.labelEntries.push(entry); return entry;
  }
  update(state) {
    if (this.disposed) return;
    if (this.state && this.state.mode !== state.mode) { this.siteSlots.clear(); this.agentSlots.clear(); this.seenEvents.clear(); this.previousDemoStep = undefined; }
    this.state = state; this.entities.clear();
    const projects = [...(state.projects || [])].sort((a, b) => a.id.localeCompare(b.id));
    const projectIds = new Set(projects.map(project => project.id));
    for (const [id, district] of this.districts) if (!projectIds.has(id)) { this.removeDistrict(district); this.districts.delete(id); }
    for (const project of projects) {
      if (!this.projectSlots.has(project.id)) this.projectSlots.set(project.id, this.projectSlots.size);
      let district = this.districts.get(project.id);
      if (!district) {
        const grid = axial(this.projectSlots.get(project.id));
        const x = Math.sqrt(3) * 5.01 * (grid.q + grid.r / 2), z = 5.01 * 1.5 * grid.r;
        const color = safeColor(project.color); const group = new THREE.Group(); group.position.set(x, 0, z);
        const platform = this.assets.optimize(this.assets.platform(color)); platform.userData.entityId = project.id; group.add(platform);
        const hq = this.assets.optimize(this.assets.headquarters(color, this.projectSlots.get(project.id))); hq.position.set(-.25, FLOOR, -1.6); hq.userData.entityId = project.id; group.add(hq);
        const pad = this.assets.optimize(this.assets.launchpad(color)); pad.position.set(-2.65, FLOOR, -2.3); pad.userData.entityId = project.id; group.add(pad);
        this.world.add(group);
        const label = this.addLabel(project.id, project.name, new THREE.Vector3(x - 1.2, .4, z - 4.95));
        district = { id: project.id, group, color, x, z, label, data: project, pad: new THREE.Vector3(x - 2.65, FLOOR + .1, z - 2.3) };
        this.districts.set(project.id, district);
      }
      district.data = project; district.label.element.textContent = project.name.toUpperCase();
      const works = (state.workItems || []).filter(work => work.projectId === project.id);
      district.label.element.title = `${project.name} · ${works.length} work items · ${(state.agents || []).filter(agent => agent.projectId === project.id).length} observed runs`;
      this.entities.set(project.id, { data: project, object: district.group, position: new THREE.Vector3(district.x, FLOOR, district.z), type: 'project' });
    }
    this.obstacles = [...this.districts.values()].map(district => ({ x: district.x - .25, z: district.z - 1.6, radius: 1.39 }));
    const visibleSites = new Set();
    for (const district of this.districts.values()) {
      const works = (state.workItems || []).filter(work => work.projectId === district.id).sort((a, b) => a.id.localeCompare(b.id));
      let slots = this.siteSlots.get(district.id); if (!slots) { slots = new Map(); this.siteSlots.set(district.id, slots); }
      // Surviving work retains its slot; retire absent reservations before reuse.
      // A returning item is reconciled against occupancy rather than overlaid.
      const currentIds = new Set(works.map(work => work.id));
      for (const id of slots.keys()) if (!currentIds.has(id)) slots.delete(id);
      const occupied = new Set(slots.values());
      for (const work of works) {
        if (!slots.has(work.id)) {
          let slot = hash(work.id) % SITES.length;
          for (let n = 0; n < SITES.length && occupied.has(slot); n++) slot = (slot + 1) % SITES.length;
          if (occupied.size < SITES.length) { slots.set(work.id, slot); occupied.add(slot); }
        }
        if (!slots.has(work.id)) {
          this.entities.set(work.id, { data: work, object: district.group, position: new THREE.Vector3(district.x, FLOOR, district.z), type: 'workItem', overflow: true });
          continue;
        }
        const slot = SITES[slots.get(work.id)], position = new THREE.Vector3(district.x + slot.x, FLOOR, district.z + slot.z);
        let site = this.sites.get(work.id);
        if (!site) {
          const object = this.assets.optimize(this.assets.workstation(district.color, slots.get(work.id))); object.position.copy(position); object.rotation.y = slot.angle;
          object.userData.entityId = work.id; this.world.add(object);
          const status = this.makeStatusIndicator(work.status); status.position.set(position.x, FLOOR + 1.38, position.z); this.world.add(status);
          site = { object, data: work, position, slot, district, status }; this.sites.set(work.id, site);
        }
        site.data = work; this.updateStatusIndicator(site.status, work.status);
        this.entities.set(work.id, { data: work, object: site.object, position: position.clone().add(new THREE.Vector3(0, .5, 0)), type: 'workItem' });
        this.obstacles.push({ x: position.x, z: position.z, radius: 1.16 });
        this.obstacles.push({ x: position.x + Math.sin(slot.angle) * 1.06, z: position.z + Math.cos(slot.angle) * 1.06, radius: .43 });
        visibleSites.add(work.id);
      }
      district.hiddenWorks = works.filter(work => !slots.has(work.id)).length;
    }
    for (const [id, site] of this.sites) if (!visibleSites.has(id)) { this.world.remove(site.object, site.status); this.assets.release(site.object); this.disposeStatus(site.status); this.sites.delete(id); }
    if (state.mode === 'DEMO' && this.previousDemoStep > state.demoStep) this.seenEvents.clear();
    this.previousDemoStep = state.demoStep;
    const events = (state.events || []).filter(event => !this.seenEvents.has(event.id));
    for (const event of events) this.seenEvents.add(event.id);
    if (this.seenEvents.size > 2000) this.seenEvents = new Set([...this.seenEvents].slice(-1000));
    const agents = [...(state.agents || [])].sort((a, b) => a.id.localeCompare(b.id));
    const visibleRobots = new Set(); const occupancy = new Map();
    // Freeze each robot's lane until its actual assignment changes. Reserve the
    // slots of every surviving run before admitting a newly observed run.
    const liveAgentIds = new Set(agents.map(agent => agent.id));
    for (const id of this.agentSlots.keys()) if (!liveAgentIds.has(id)) this.agentSlots.delete(id);
    for (const [id, assignment] of this.agentSlots) {
      if (!liveAgentIds.has(id)) continue;
      const agent = agents.find(item => item.id === id);
      const groupKey = this.sites.has(agent.workItemId) ? agent.workItemId : `${agent.projectId}:idle`;
      if (groupKey !== assignment.groupKey) continue;
      if (!occupancy.has(groupKey)) occupancy.set(groupKey, new Set());
      occupancy.get(groupKey).add(assignment.slot);
    }
    for (const agent of agents) {
      const district = this.districts.get(agent.projectId); if (!district) continue;
      const site = this.sites.get(agent.workItemId);
      const groupKey = site ? site.data.id : `${district.id}:idle`;
      if (!occupancy.has(groupKey)) occupancy.set(groupKey, new Set());
      const taken = occupancy.get(groupKey), previous = this.agentSlots.get(agent.id);
      let rank = previous?.groupKey === groupKey ? previous.slot : 0;
      if (previous?.groupKey !== groupKey) { while (taken.has(rank)) rank++; taken.add(rank); this.agentSlots.set(agent.id, { groupKey, slot: rank }); }
      // Explicit crowd limits leave every run available in the accessible item list.
      if (visibleRobots.size >= MAX_ROBOTS || rank >= (site ? 3 : 5)) {
        this.entities.set(agent.id, { data: agent, object: site?.object || district.group, position: site?.position || new THREE.Vector3(district.x, FLOOR, district.z), type: 'agent', overflow: true }); continue;
      }
      let target;
      if (site) {
        const outward = new THREE.Vector3(Math.sin(site.slot.angle), 0, Math.cos(site.slot.angle));
        const tangent = new THREE.Vector3(outward.z, 0, -outward.x);
        target = site.position.clone().addScaledVector(outward, 1.52).addScaledVector(tangent, (rank - .8) * .46); target.y = FLOOR;
      } else {
        // A reserved quiet apron by the launch pad. Never invented movement in LIVE.
        const apron = [[-2.8, -2.8], [-2.15, -3.35], [-1.5, -3.5], [-.85, -3.8], [-.2, -4.1]][rank];
        target = new THREE.Vector3(district.x + apron[0], FLOOR, district.z + apron[1]);
      }
      let robot = this.robots.get(agent.id);
      if (!robot) {
        const model = createRobot({ color: district.color, status: agent.status, reducedMotion: this.reducedMotion });
        model.object.traverse(part => { if (part.isMesh) part.castShadow = false; });
        const shadow = new THREE.Mesh(this.assets.geometry('robot-contact', () => { const geometry = new THREE.CircleGeometry(.3, 16); geometry.rotateX(-Math.PI / 2); return geometry; }), this.assets.material('#40533e', { transparent: true, opacity: .17, depthWrite: false }));
        shadow.position.y = .008; model.object.add(shadow);
        model.object.userData.entityId = agent.id; model.object.position.copy(target); this.world.add(model.object);
        robot = { model, data: agent, target, assigned: agent.workItemId || null, path: [], waypoint: 0, activeUntil: 0 };
        const arrival = events.some(event => (event.agentId === agent.id || event.entityId === agent.id) && /arriv|creat|start|handoff|assign/.test(`${event.type} ${event.kind || ''}`));
        if (arrival && !this.reducedMotion) { model.object.position.copy(district.pad); robot.path = this.findPath(district.pad, target); robot.waypoint = 0; }
        this.robots.set(agent.id, robot);
      } else {
        if (robot.assigned !== (agent.workItemId || null) || robot.data.projectId !== agent.projectId) {
          robot.path = this.reducedMotion ? [] : this.findPath(robot.model.object.position, target); robot.waypoint = 0;
          if (!robot.path.length) robot.model.object.position.copy(target);
        }
        if (robot.data.status !== agent.status && agent.status === 'completed') robot.activeUntil = performance.now() + 1350;
        robot.model.setStatus(agent.status); robot.target = target; robot.data = agent; robot.assigned = agent.workItemId || null;
      }
      if (!robot.path.length) robot.model.object.position.copy(target);
      if (!robot.path.length && site) robot.model.object.rotation.y = site.slot.angle + Math.PI;
      this.entities.set(agent.id, { data: agent, object: robot.model.object, position: robot.model.object.position, type: 'agent' }); visibleRobots.add(agent.id);
    }
    for (const [id, robot] of this.robots) if (!visibleRobots.has(id)) { this.world.remove(robot.model.object); robot.model.dispose(); this.robots.delete(id); }
    // Count actual omitted runs without pretending that a crowded marker is a run.
    for (const district of this.districts.values()) {
      const hiddenRuns = agents.filter(agent => agent.projectId === district.id && !visibleRobots.has(agent.id)).length;
      district.label.element.dataset.hiddenRuns = String(hiddenRuns);
      if (hiddenRuns) district.label.element.title += ` · ${hiddenRuns} runs in item list`;
      const overflow = [district.hiddenWorks ? `+${district.hiddenWorks} work sites` : '', hiddenRuns ? `+${hiddenRuns} runs` : ''].filter(Boolean);
      if (overflow.length && !district.overflow) district.overflow = this.addLabel(district.id, '', new THREE.Vector3(district.x, .5, district.z + 4.45), 'colony-overflow');
      if (district.overflow) {
        district.overflow.element.hidden = !overflow.length;
        district.overflow.element.textContent = `${overflow.join(' · ')} in Explore`;
        district.overflow.element.setAttribute('aria-label', `${overflow.join(', ')} available in the Explore item list`);
      }
    }
    const topology = [...this.districts.keys()].join('|');
    if (topology !== this.topology) { this.topology = topology; this.rebuildNature(); this.updateBounds(); }
    if (!this.didFit && this.districts.size) { this.fit(); this.didFit = true; }
    this.select(this.selectedId); this.renderer.shadowMap.needsUpdate = true; this.invalidate();
  }

  makeStatusIndicator(status) {
    const group = new THREE.Group();
    const post = this.assets.cylinder(.025, .025, .28, '#738582', 6); post.position.y = -.1; group.add(post);
    const light = this.assets.sphere(.105, STATUS_COLORS[status] || STATUS_COLORS.unknown); light.position.y = .08; group.add(light); group.userData.light = light;
    this.updateStatusIndicator(group, status); return group;
  }
  updateStatusIndicator(group, status) {
    group.userData.light.material = this.assets.material(STATUS_COLORS[status] || STATUS_COLORS.unknown, { emissive: STATUS_COLORS[status] || STATUS_COLORS.unknown, emissiveIntensity: .15 });
    // Static shape + glyph keeps input and failure states readable without
    // relying on color or motion. A changed glyph releases its old texture.
    const flagStyle = status === 'waiting' ? { glyph: '?', paper: '#fff6d8', edge: '#c99b41', ink: '#9b722b' }
      : ['changes_requested', 'failed'].includes(status) ? { glyph: '!', paper: '#fff0e7', edge: '#cd7967', ink: '#ab584a' } : null;
    if (flagStyle && group.userData.flagGlyph !== flagStyle.glyph) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 96;
      const context = canvas.getContext('2d'); context.fillStyle = flagStyle.paper; context.beginPath(); context.roundRect(6, 6, 84, 84, 26); context.fill();
      context.lineWidth = 4; context.strokeStyle = flagStyle.edge; context.stroke(); context.fillStyle = flagStyle.ink; context.font = 'bold 68px system-ui'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(flagStyle.glyph, 48, 50);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
      if (group.userData.flag) { group.userData.flag.material.map.dispose(); group.userData.flag.material.dispose(); group.userData.flag.material = material; }
      else { const sprite = new THREE.Sprite(material); sprite.scale.set(.65, .65, 1); sprite.position.y = .47; group.add(sprite); group.userData.flag = sprite; }
      group.userData.flagGlyph = flagStyle.glyph;
    }
    if (group.userData.flag) group.userData.flag.visible = !!flagStyle;
  }

  disposeStatus(group) {
    const sprite = group.userData.flag; if (sprite) { sprite.material.map.dispose(); sprite.material.dispose(); } this.assets.release(group);
  }
  removeDistrict(district) {
    this.world.remove(district.group); this.assets.release(district.group);
    for (const label of [district.label, district.overflow].filter(Boolean)) { label.element.remove(); this.labelEntries = this.labelEntries.filter(entry => entry !== label); }
  }
  updateBounds() {
    const districts = [...this.districts.values()];
    this.worldBounds = { minX: Math.min(...districts.map(d => d.x - 5)), maxX: Math.max(...districts.map(d => d.x + 5)), minZ: Math.min(...districts.map(d => d.z - 5)), maxZ: Math.max(...districts.map(d => d.z + 5)) };
  }
  rebuildNature() {
    this.assets.release(this.nature); this.nature.clear();
    if (!this.districts.size) return;
    const districts = [...this.districts.values()];
    const random = seed => { const a = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return a - Math.floor(a); };
    const minX = Math.min(...districts.map(d => d.x)) - 9, maxX = Math.max(...districts.map(d => d.x)) + 9;
    const minZ = Math.min(...districts.map(d => d.z)) - 9, maxZ = Math.max(...districts.map(d => d.z)) + 9;
    for (let i = 0; i < 78; i++) {
      const x = minX + random(i + 15) * (maxX - minX), z = minZ + random(i + 418) * (maxZ - minZ);
      if (districts.some(d => hexInside((x - d.x) / 1.23, (z - d.z) / 1.23, 0))) continue;
      const near = Math.min(...districts.map(d => Math.hypot(x - d.x, z - d.z)));
      if (near > 13 || near < 5.7) continue;
      if (i % 3 === 0) {
        const tree = this.assets.tree(.65 + random(i + 70) * .5, i); tree.position.set(x, -.15, z); tree.rotation.y = random(i + 8) * Math.PI; this.nature.add(tree);
      } else if (i % 3 === 1) {
        const stone = this.assets.sphere(.14 + random(i) * .16, '#aab69a'); stone.scale.y = .5; stone.position.set(x, -.09, z); this.nature.add(stone);
      } else {
        const tuft = new THREE.Group();
        for (let j = 0; j < 3; j++) { const blade = this.assets.box(.025, .19 + j * .03, .04, '#81986f'); blade.position.set(j * .08, .05, 0); blade.rotation.z = (j - 1) * -.23; tuft.add(blade); }
        tuft.position.set(x, -.15, z); this.nature.add(tuft);
      }
    }
    this.assets.optimize(this.nature);
  }

  // Navigation uses a deterministic grid through the union of district decks.
  // Inflated footprints reserve clearance for both the robot and console geometry.
  findPath(start, destination) {
    const step = .36;
    const districts = [...this.districts.values()];
    const minX = Math.min(...districts.map(d => d.x)) - 5.1, minZ = Math.min(...districts.map(d => d.z)) - 5.1;
    const point = (x, z) => ({ x: minX + x * step, z: minZ + z * step });
    const key = (x, z) => `${x},${z}`;
    const cell = position => ({ x: Math.round((position.x - minX) / step), z: Math.round((position.z - minZ) / step) });
    const walkable = (x, z) => {
      const p = point(x, z);
      return districts.some(d => hexInside(p.x - d.x, p.z - d.z, .23)) && !this.obstacles.some(o => Math.hypot(p.x - o.x, p.z - o.z) < o.radius);
    };
    const nearest = position => {
      const c = cell(position); if (walkable(c.x, c.z)) return c;
      for (let r = 1; r < 8; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) === r && walkable(c.x + dx, c.z + dz)) return { x: c.x + dx, z: c.z + dz };
      return null;
    };
    const a = nearest(start), b = nearest(destination); if (!a || !b) return [];
    const open = [{ ...a, g: 0, f: Math.hypot(a.x - b.x, a.z - b.z) }], best = new Map([[key(a.x, a.z), 0]]), parents = new Map();
    let found = false, iter = 0;
    while (open.length && iter++ < 10000) {
      let low = 0; for (let i = 1; i < open.length; i++) if (open[i].f < open[low].f) low = i;
      const current = open.splice(low, 1)[0];
      if (current.x === b.x && current.z === b.z) { found = true; break; }
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        const x = current.x + dx, z = current.z + dz;
        if (!walkable(x, z) || (dx && dz && (!walkable(current.x + dx, current.z) || !walkable(current.x, current.z + dz)))) continue;
        const score = current.g + Math.hypot(dx, dz), k = key(x, z);
        if (score >= (best.get(k) ?? Infinity)) continue;
        best.set(k, score); parents.set(k, current); open.push({ x, z, g: score, f: score + Math.hypot(x - b.x, z - b.z) });
      }
    }
    if (!found) return [];
    const path = [destination.clone()]; let current = b;
    while (current && (current.x !== a.x || current.z !== a.z)) { const p = point(current.x, current.z); path.push(new THREE.Vector3(p.x, FLOOR, p.z)); current = parents.get(key(current.x, current.z)); }
    path.reverse(); return path;
  }

  select(id) {
    this.selectedId = id;
    for (const entry of this.labelEntries) { entry.element.classList.toggle('selected', entry.id === id); entry.element.setAttribute('aria-pressed', String(entry.id === id)); }
    const entity = this.entities.get(id); this.selectionRing.visible = !!entity;
    if (entity) {
      const radius = entity.type === 'project' ? 2.7 : entity.type === 'workItem' ? 1.04 : .48;
      this.selectionRing.scale.setScalar(radius / .48);
      this.selectionRing.position.set(entity.position.x, FLOOR + .012, entity.position.z);
    }
    this.rebuildConnections(); this.invalidate();
  }
  rebuildConnections() {
    this.assets.release(this.connections); this.connections.clear();
    if (!this.state || !this.selectedId) return;
    const relations = (this.state.relationships || []).filter(relation => relation.fromId === this.selectedId || relation.toId === this.selectedId).slice(0, 12);
    for (const relation of relations) {
      const from = this.entities.get(relation.fromId), to = this.entities.get(relation.toId); if (!from || !to) continue;
      const a = from.position.clone(), b = to.position.clone(); a.y += .25; b.y += .25;
      const center = a.clone().lerp(b, .5); center.y += Math.min(2, a.distanceTo(b) * .17 + .45);
      const points = new THREE.QuadraticBezierCurve3(a, center, b).getPoints(32);
      const color = relation.provenance === 'inferred' ? '#8e9c97' : relation.provenance === 'demo' || this.state.mode === 'DEMO' ? '#7d729f' : '#507f82';
      const line = this.assets.line(points, color, .72); line.userData.fromId = relation.fromId; line.userData.toId = relation.toId; this.connections.add(line);
    }
  }
  focus(id) {
    const entity = this.entities.get(id); if (!entity) return;
    const target = new THREE.Vector3(entity.position.x, .3, entity.position.z);
    const compact = this.width <= 600, toZoom = Math.max(this.camera.zoom, entity.type === 'project' ? .95 : compact ? 1.25 : 1.5);
    if (compact) {
      // Mobile details are a bottom sheet: frame the selected object in the
      // clear upper third, using camera-space up without tilting the deck.
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion); up.y = 0;
      const lift = (1 - 2 * .32) * 11 / toZoom;
      target.addScaledVector(up, -lift / Math.max(.1, up.lengthSq()));
    }
    if (this.reducedMotion) { this.camera.position.add(target.clone().sub(this.controls.target)); this.controls.target.copy(target); this.camera.zoom = toZoom; this.camera.updateProjectionMatrix(); this.controls.update(); }
    else this.flight = { start: performance.now(), from: this.controls.target.clone(), to: target, camera: this.camera.position.clone(), zoom: this.camera.zoom, toZoom };
    this.invalidate();
  }
  follow(id = null) { this.followId = id; if (id) this.focus(id); }
  fit() {
    if (!this.districts.size || !this.width) return;
    this.updateBounds();
    const b = this.worldBounds, target = new THREE.Vector3((b.minX + b.maxX) / 2, .3, (b.minZ + b.maxZ) / 2);
    this.controls.target.copy(target); this.camera.position.copy(target).add(this.width <= 600 ? new THREE.Vector3(30, 28, 4) : new THREE.Vector3(19, 24, 26)); this.camera.lookAt(target);
    this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
    const points = [];
    for (const district of this.districts.values()) for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; points.push(new THREE.Vector3(district.x + Math.sin(a) * 5.4, 1, district.z + Math.cos(a) * 5.4).project(this.camera)); }
    const rangeX = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), rangeY = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
    this.camera.zoom = THREE.MathUtils.clamp(Math.min(1.65 / rangeX, (this.width <= 600 ? 1.05 : 1.58) / rangeY), .2, 1.65);
    this.camera.updateProjectionMatrix(); this.controls.update(); this.flight = null; this.followId = null; this.invalidate();
  }
  zoom(factor) { this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, this.controls.minZoom, this.controls.maxZoom); this.camera.updateProjectionMatrix(); this.invalidate(); }
  screenPosition(id) {
    const entity = this.entities.get(id); if (!entity || !this.width) return null;
    const position = entity.position.clone(); position.y += entity.type === 'agent' ? .5 : entity.type === 'workItem' ? .25 : .7;
    const projected = position.project(this.camera), rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (projected.x + 1) / 2 * rect.width, y: rect.top + (1 - projected.y) / 2 * rect.height };
  }
  updateLabels() {
    const rect = { width: this.width || 0, height: this.height || 0 };
    for (const entry of this.labelEntries) {
      const p = entry.position.clone().project(this.camera), x = (p.x + 1) / 2 * rect.width, y = (1 - p.y) / 2 * rect.height;
      entry.element.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
      entry.element.style.visibility = p.z < -1 || p.z > 1 || x < -100 || x > rect.width + 100 || y < -40 || y > rect.height + 40 ? 'hidden' : 'visible';
    }
  }
  schedule() { if (!this.raf && !this.disposed && !this.contextLost && !document.hidden) this.raf = requestAnimationFrame(time => { this.raf = 0; this.frame(time); }); }
  frame(time) {
    if (this.disposed || this.contextLost || document.hidden) return;
    const elapsed = time - this.lastFrame, dt = Math.max(0, Math.min(elapsed / 1000, .25)); this.lastFrame = time;
    if (this.renderFrameCount > 2 && this.wasAnimating && elapsed > 0 && elapsed < 10000 && this.quality !== 'reduced') {
      this.frameSamples = (this.frameSamples || 0) + 1; this.frameElapsed = (this.frameElapsed || 0) + elapsed;
      // Wall time gives slow devices a useful fallback in seconds, rather than
      // waiting for 120 frames that could take a minute on a software renderer.
      if (this.frameSamples >= 6 && this.frameElapsed >= 3000) {
        if (this.frameElapsed / this.frameSamples > 32) {
          this.quality = 'reduced'; this.renderer.setPixelRatio(.75); this.renderer.setSize(this.width, this.height, false);
          this.renderer.shadowMap.type = THREE.BasicShadowMap;
          this.sunlight.shadow.mapSize.set(1024, 1024); this.sunlight.shadow.map?.dispose(); this.sunlight.shadow.map = null;
          this.scene.traverse(object => { for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) material.needsUpdate = true; });
          this.renderer.shadowMap.needsUpdate = true; this.invalidate();
        }
        this.frameSamples = 0; this.frameElapsed = 0;
      }
    }
    let animated = false;
    for (const robot of this.robots.values()) {
      const moving = robot.waypoint < robot.path.length;
      if (moving && !this.reducedMotion) {
        const next = robot.path[robot.waypoint], delta = next.clone().sub(robot.model.object.position); delta.y = 0;
        const distance = delta.length(), speed = 1.65 * dt;
        if (distance <= speed) { robot.model.object.position.copy(next); robot.waypoint++; }
        else { robot.model.object.position.addScaledVector(delta, speed / distance); robot.model.object.rotation.y = Math.atan2(delta.x, delta.z); }
        if (robot.waypoint === robot.path.length) { robot.path = []; const site = this.sites.get(robot.data.workItemId); if (site) robot.model.object.rotation.y = site.slot.angle + Math.PI; }
      } else if (moving && this.reducedMotion) { robot.model.object.position.copy(robot.target); robot.path = []; }
      robot.model.animate(time / 1000, { moving, reducedMotion: this.reducedMotion });
      if (!this.reducedMotion && (moving || robot.activeUntil > time || ['working', 'reviewing'].includes(robot.data.status))) animated = true;
    }
    if (this.flight) {
      const f = this.flight, progress = THREE.MathUtils.clamp((time - f.start) / 650, 0, 1), ease = progress * progress * (3 - 2 * progress);
      const target = f.from.clone().lerp(f.to, ease); this.controls.target.copy(target); this.camera.position.copy(f.camera).add(target.clone().sub(f.from));
      this.camera.zoom = THREE.MathUtils.lerp(f.zoom, f.toZoom, ease); this.camera.updateProjectionMatrix();
      if (progress >= 1) this.flight = null; animated = true;
    } else if (this.followId && !this.reducedMotion) {
      const robot = this.robots.get(this.followId); if (robot) {
        const desired = robot.model.object.position.clone(); desired.y = .3;
        const delta = desired.sub(this.controls.target).multiplyScalar(Math.min(1, dt * 2.5)); this.controls.target.add(delta); this.camera.position.add(delta); animated = true;
      }
    }
    const changed = this.controls.update();
    if (this.needsRender || animated || changed) {
      const selected = this.entities.get(this.selectedId);
      if (selected) this.selectionRing.position.set(selected.position.x, FLOOR + .015, selected.position.z);
      for (const line of this.connections.children) {
        const from = this.entities.get(line.userData.fromId), to = this.entities.get(line.userData.toId);
        if (!from || !to) continue;
        const a = from.position.clone(), b = to.position.clone(); a.y += .25; b.y += .25;
        const center = a.clone().lerp(b, .5); center.y += Math.min(2, a.distanceTo(b) * .17 + .45);
        const points = new THREE.QuadraticBezierCurve3(a, center, b).getPoints(32), positions = line.geometry.getAttribute('position');
        points.forEach((point, index) => positions.setXYZ(index, point.x, point.y, point.z)); positions.needsUpdate = true; line.geometry.computeBoundingSphere();
      }
      this.updateLabels(); this.renderer.render(this.scene, this.camera); this.renderFrameCount++;
      if (this.districts.size) this.canvas.dataset.ready = 'true';
      this.needsRender = false;
    }
    this.wasAnimating = animated || changed;
    if (animated || changed || this.flight || this.needsRender) this.schedule();
  }
  stats() {
    return { districts: this.districts.size, workSites: this.sites.size, robots: this.robots.size, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderFrameCount: this.renderFrameCount, disposed: this.disposed, paused: document.hidden || !this.raf, quality: this.quality, softwareRendering: this.softwareRendering, contextLost: this.contextLost, width: this.width || 0, height: this.height || 0, reducedMotion: this.reducedMotion, pixelRatio: this.renderer.getPixelRatio(), visibleRobotLimit: MAX_ROBOTS, hiddenRuns: Math.max(0, (this.state?.agents.length || 0) - this.robots.size), hiddenWorkSites: Math.max(0, (this.state?.workItems.length || 0) - this.sites.size) };
  }
  dispose() {
    if (this.disposed) return; this.disposed = true; cancelAnimationFrame(this.raf); this.raf = 0;
    this.observer.disconnect(); this.controls.removeEventListener('start', this.onControlStart); this.controls.removeEventListener('change', this.onControlChange); this.controls.dispose();
    this.reducedQuery.removeEventListener('change', this.onReduced); document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown); this.canvas.removeEventListener('pointerup', this.onPointerUp); this.canvas.removeEventListener('pointermove', this.onPointerMove); this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    for (const robot of this.robots.values()) robot.model.dispose();
    for (const site of this.sites.values()) this.disposeStatus(site.status);
    this.assets.release(this.scene); this.assets.dispose(); this.sunlight.shadow.map?.dispose(); this.renderer.dispose();
    this.labelLayer.remove(); this.canvas.remove(); this.labelEntries = []; this.scene.clear();
    this.entities.clear(); this.robots.clear(); this.sites.clear(); this.districts.clear(); this.siteSlots.clear(); this.agentSlots.clear(); this.projectSlots.clear(); this.seenEvents.clear(); this.state = null;
  }
}
