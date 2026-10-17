import * as THREE from '/vendor/three.module.js';

// Original, procedural colony robots. Geometry and the fixed palette are shared
// across instances; the last disposed robot releases the shared GPU resources.
let shared = null;
let references = 0;

const STATUS = {
  working: { color: '#38a6b5', glyph: '·', label: 'Working' },
  reviewing: { color: '#8181cb', glyph: '⌕', label: 'Reviewing' },
  waiting: { color: '#e7ad46', glyph: '?', label: 'Waiting for input' },
  idle: { color: '#88a399', glyph: '–', label: 'Idle' },
  completed: { color: '#62ae79', glyph: '✓', label: 'Run completed' },
  failed: { color: '#d77665', glyph: '!', label: 'Failed or blocked' },
  changes_requested: { color: '#d77665', glyph: '!', label: 'Changes requested' },
  blocked: { color: '#d77665', glyph: '!', label: 'Blocked' },
  unknown: { color: '#9ca8ac', glyph: '?', label: 'Unknown activity' },
  stale: { color: '#9ca8ac', glyph: '–', label: 'Stale activity' },
};

function statusKey(value) {
  const key = String(value || 'unknown').toLowerCase();
  if (key === 'waiting_for_input' || key === 'needs_andre' || key === 'awaiting_approval') return 'waiting';
  if (key === 'running' || key === 'active') return 'working';
  if (key === 'complete' || key === 'done' || key === 'success') return 'completed';
  return Object.hasOwn(STATUS, key) ? key : 'unknown';
}

function makeBadge(glyph, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 112;
  const context = canvas.getContext('2d');
  context.beginPath();
  context.roundRect(9, 6, 78, 78, 24);
  context.fillStyle = '#f8fbf6';
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = color;
  context.stroke();
  context.beginPath();
  context.moveTo(37, 83);
  context.lineTo(48, 96);
  context.lineTo(59, 83);
  context.fillStyle = color;
  context.fill();
  context.fillStyle = color;
  context.font = '700 55px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(glyph, 48, 47);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
}

function acquireResources() {
  if (!shared) {
    const shape = new THREE.Shape();
    shape.moveTo(-0.4, -0.4);
    shape.lineTo(0.4, -0.4);
    shape.lineTo(0.4, 0.4);
    shape.lineTo(-0.4, 0.4);
    shape.closePath();
    const rounded = new THREE.ExtrudeGeometry(shape, {
      depth: 0.8, bevelEnabled: true, bevelThickness: 0.1,
      bevelSize: 0.1, bevelSegments: 3, steps: 1, curveSegments: 3,
    });
    rounded.translate(0, 0, -0.4);
    const material = (color, extra = {}) => new THREE.MeshStandardMaterial({
      color, roughness: 0.65, metalness: 0.08, ...extra,
    });
    shared = {
      geometry: {
        rounded,
        sphere: new THREE.SphereGeometry(1, 12, 8),
        cylinder: new THREE.CylinderGeometry(1, 1, 1, 10),
        cone: new THREE.ConeGeometry(1, 1, 10),
      },
      material: {
        shell: material('#f3f6ec'),
        edge: material('#d6e0d9'),
        dark: material('#263c45'),
        joint: material('#677f83'),
        metal: material('#b6c7c6', { metalness: 0.4, roughness: 0.5 }),
        eye: material('#9de6e5', { emissive: '#48bbcd', emissiveIntensity: 0.55 }),
        scanner: material('#91c9d4', { emissive: '#568ca9', emissiveIntensity: 0.35 }),
        batched: material('#ffffff', { vertexColors: true }),
      },
      badges: new Map(),
    };
  }
  references += 1;
  return shared;
}

function releaseResources(resources) {
  references -= 1;
  if (references !== 0 || shared !== resources) return;
  Object.values(resources.geometry).forEach((geometry) => geometry.dispose());
  Object.values(resources.material).forEach((material) => material.dispose());
  resources.badges.forEach((material) => {
    material.map.dispose();
    material.dispose();
  });
  shared = null;
}

/**
 * The root is floor-aligned, faces +Z and is .88 world units tall (.50 wide).
 * The status marker reaches 1.2 units. Callers own the root transform entirely.
 * animate() changes only internal joints; travel belongs to the world renderer.
 */
export function createRobot({ color = '#64a9ad', status = 'unknown', reducedMotion = false } = {}) {
  const resources = acquireResources();
  const { geometry, material } = resources;
  const object = new THREE.Group();
  object.name = 'colony-robot';
  const accent = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.07 });
  const indicator = new THREE.MeshStandardMaterial({ color: '#9ca8ac', roughness: 0.55 });
  const ownedGeometries = [];
  const statusColors = [];
  let disposed = false;
  let currentStatus;
  let transitionStart = null;

  function mesh(parent, name, geometryName, surface, position, scale) {
    const part = new THREE.Mesh(geometry[geometryName], surface);
    part.name = name;
    part.position.set(...position);
    part.scale.set(...scale);
    part.castShadow = true;
    part.receiveShadow = true;
    parent.add(part);
    return part;
  }

  // Only direct mesh children are baked, so articulated child groups keep their
  // own pivot. Palette colors become vertex colors: a whole body or limb takes
  // one draw call rather than a call for each white panel, joint, and trim piece.
  function batchPivot(group, surface = material.batched) {
    const parts = group.children.filter((part) => part.isMesh);
    const pieces = [];
    let vertexCount = 0;
    for (const part of parts) {
      const piece = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
      part.updateMatrix();
      piece.applyMatrix4(part.matrix);
      const count = piece.getAttribute('position').count;
      pieces.push({ geometry: piece, color: part.material.color, count, start: vertexCount, dynamic: part.material === indicator });
      vertexCount += count;
      part.removeFromParent();
    }
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    for (const piece of pieces) {
      positions.set(piece.geometry.getAttribute('position').array, piece.start * 3);
      normals.set(piece.geometry.getAttribute('normal').array, piece.start * 3);
      for (let i = piece.start; i < piece.start + piece.count; i++) {
        colors[i * 3] = piece.color.r;
        colors[i * 3 + 1] = piece.color.g;
        colors[i * 3 + 2] = piece.color.b;
      }
      piece.geometry.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    const colorAttribute = new THREE.BufferAttribute(colors, 3);
    if (pieces.some((piece) => piece.dynamic)) colorAttribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttribute);
    geometry.computeBoundingSphere();
    for (const piece of pieces) {
      if (piece.dynamic) statusColors.push({ attribute: colorAttribute, start: piece.start, count: piece.count });
    }
    const combined = new THREE.Mesh(geometry, surface);
    combined.name = `${group.name || 'robot-pivot'}-shell`;
    combined.castShadow = true;
    combined.receiveShadow = true;
    group.add(combined);
    ownedGeometries.push(geometry);
  }

  const chassis = new THREE.Group();
  object.add(chassis);
  mesh(chassis, 'body', 'rounded', material.shell, [0, 0.36, 0], [0.32, 0.29, 0.27]);
  mesh(chassis, 'waist', 'rounded', material.dark, [0, 0.205, 0], [0.27, 0.07, 0.23]);
  mesh(chassis, 'chest-trim', 'rounded', accent, [0, 0.393, 0.14], [0.23, 0.085, 0.025]);
  mesh(chassis, 'chest-panel', 'rounded', material.edge, [0, 0.3, 0.142], [0.14, 0.048, 0.018]);
  mesh(chassis, 'chest-status', 'sphere', indicator, [0.085, 0.30, 0.155], [0.022, 0.022, 0.012]);
  mesh(chassis, 'backpack', 'rounded', accent, [0, 0.365, -0.17], [0.22, 0.22, 0.12]);
  mesh(chassis, 'backpack-battery', 'rounded', material.edge, [0, 0.365, -0.235], [0.13, 0.14, 0.025]);
  [-0.042, 0, 0.042].forEach((x) => {
    mesh(chassis, 'backpack-vent', 'rounded', material.joint, [x, 0.38, -0.253], [0.014, 0.07, 0.008]);
  });
  mesh(chassis, 'neck', 'cylinder', material.joint, [0, 0.52, 0], [0.065, 0.07, 0.065]);

  const head = new THREE.Group();
  head.position.y = 0.655;
  chassis.add(head);
  mesh(head, 'head-shell', 'rounded', material.shell, [0, 0, 0], [0.43, 0.255, 0.33]);
  mesh(head, 'visor', 'rounded', material.dark, [0, 0.005, 0.164], [0.351, 0.145, 0.032]);
  const eyes = new THREE.Group();
  eyes.name = 'paired-eyes';
  eyes.position.y = 0.008;
  head.add(eyes);
  mesh(eyes, 'left-eye', 'rounded', material.eye, [-0.086, 0, 0.185], [0.043, 0.059, 0.012]);
  mesh(eyes, 'right-eye', 'rounded', material.eye, [0.086, 0, 0.185], [0.043, 0.059, 0.012]);
  mesh(head, 'temple-left', 'cylinder', accent, [-0.225, 0, 0], [0.065, 0.035, 0.065]).rotation.z = Math.PI / 2;
  mesh(head, 'temple-right', 'cylinder', accent, [0.225, 0, 0], [0.065, 0.035, 0.065]).rotation.z = Math.PI / 2;
  mesh(head, 'antenna-stem', 'cylinder', material.joint, [0.13, 0.165, -0.045], [0.013, 0.08, 0.013]);
  mesh(head, 'antenna-light', 'sphere', indicator, [0.13, 0.212, -0.045], [0.029, 0.029, 0.029]);

  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.205, 0.445, 0);
    chassis.add(arm);
    mesh(arm, 'shoulder', 'sphere', accent, [0, 0, 0], [0.067, 0.066, 0.065]);
    mesh(arm, 'arm', 'rounded', material.shell, [side * 0.018, -0.102, 0], [0.071, 0.15, 0.078]);
    mesh(arm, 'elbow', 'sphere', material.joint, [side * 0.018, -0.18, 0], [0.038, 0.038, 0.038]);
    mesh(arm, 'hand', 'rounded', material.edge, [side * 0.018, -0.222, 0.022], [0.075, 0.075, 0.078]);
    return arm;
  });

  const tool = new THREE.Group();
  tool.position.set(0.018, -0.205, 0.065);
  arms[1].add(tool);
  mesh(tool, 'tool-grip', 'rounded', material.dark, [0, 0, 0], [0.035, 0.15, 0.035]);
  mesh(tool, 'tool-collar', 'rounded', accent, [0, 0.068, 0], [0.065, 0.04, 0.055]);
  mesh(tool, 'tool-head', 'rounded', material.metal, [0, 0.11, 0], [0.14, 0.055, 0.075]);

  const scanner = new THREE.Group();
  scanner.position.set(0.018, -0.202, 0.07);
  arms[1].add(scanner);
  mesh(scanner, 'scanner-grip', 'rounded', material.dark, [0, 0.015, 0], [0.045, 0.085, 0.045]);
  mesh(scanner, 'scanner-shell', 'rounded', material.shell, [0, 0.07, 0.015], [0.14, 0.105, 0.075]);
  mesh(scanner, 'scanner-screen', 'rounded', material.scanner, [0, 0.075, 0.06], [0.105, 0.063, 0.015]);
  mesh(scanner, 'scanner-light', 'sphere', indicator, [0.048, 0.11, 0.062], [0.012, 0.012, 0.009]);

  const legs = [-1, 1].map((side) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.092, 0.185, 0);
    object.add(leg);
    mesh(leg, 'leg', 'rounded', material.joint, [0, -0.06, 0], [0.066, 0.12, 0.065]);
    mesh(leg, 'boot', 'rounded', material.shell, [0, -0.124, 0.023], [0.12, 0.092, 0.185]);
    mesh(leg, 'boot-sole', 'rounded', material.dark, [0, -0.166, 0.022], [0.12, 0.025, 0.183]);
    return leg;
  });

  // Nine meshes cover every articulated part, with at most one tool visible.
  [chassis, head, ...arms, ...legs, tool, scanner].forEach((pivot) => batchPivot(pivot));
  batchPivot(eyes, material.eye);
  // These two materials served only as construction-time palette values.
  accent.dispose();
  indicator.dispose();

  if (!resources.badges.has('unknown')) {
    resources.badges.set('unknown', makeBadge(STATUS.unknown.glyph, STATUS.unknown.color));
  }
  const badge = new THREE.Sprite(resources.badges.get('unknown'));
  badge.name = 'robot-status';
  badge.position.set(0, 1.06, 0);
  badge.scale.set(0.30, 0.35, 1);
  object.add(badge);

  function setStatus(value) {
    if (disposed) return;
    const nextStatus = statusKey(value);
    if (nextStatus === currentStatus) return;
    currentStatus = nextStatus;
    transitionStart = null;
    const appearance = STATUS[currentStatus];
    const lightColor = new THREE.Color(appearance.color);
    for (const { attribute, start, count } of statusColors) {
      for (let i = start; i < start + count; i++) attribute.setXYZ(i, lightColor.r, lightColor.g, lightColor.b);
      attribute.needsUpdate = true;
    }
    tool.visible = currentStatus === 'working';
    scanner.visible = currentStatus === 'reviewing';
    badge.visible = ['waiting', 'completed', 'failed', 'changes_requested', 'blocked', 'unknown', 'stale'].includes(currentStatus);
    if (badge.visible) {
      if (!resources.badges.has(currentStatus)) {
        resources.badges.set(currentStatus, makeBadge(appearance.glyph, appearance.color));
      }
      badge.material = resources.badges.get(currentStatus);
    }
    object.userData.status = currentStatus;
    object.userData.statusLabel = appearance.label;
    // A state update immediately applies its static pose, including when hidden.
    pose(0, false, true);
  }

  function pose(time, moving, still) {
    const cycle = still ? 0 : time;
    head.rotation.set(0, 0, 0);
    arms.forEach((arm) => arm.rotation.set(0, 0, 0));
    legs.forEach((leg) => leg.rotation.set(0, 0, 0));
    eyes.scale.y = 1;
    badge.scale.set(0.30, 0.35, 1);

    if (moving && !still) {
      const stride = Math.sin(cycle * 8) * 0.28;
      legs[0].rotation.x = stride;
      legs[1].rotation.x = -stride;
      arms[0].rotation.x = -stride * 0.7;
      arms[1].rotation.x = stride * 0.7;
    } else if (currentStatus === 'working') {
      arms[1].rotation.x = -0.85 + (still ? 0 : Math.sin(cycle * 5.8) * 0.18);
      arms[0].rotation.x = -0.4;
      head.rotation.x = 0.12;
      head.rotation.y = -0.1;
    } else if (currentStatus === 'reviewing') {
      arms[1].rotation.x = -1.05;
      arms[1].rotation.y = still ? -0.15 : Math.sin(cycle * 1.25) * 0.19;
      head.rotation.y = still ? 0.12 : Math.sin(cycle * 1.25) * 0.16;
      head.rotation.x = 0.08;
    } else if (currentStatus === 'waiting') {
      head.rotation.z = -0.11;
      arms[0].rotation.z = 0.22;
      arms[1].rotation.z = -0.22;
    } else if (['failed', 'changes_requested', 'blocked'].includes(currentStatus)) {
      head.rotation.x = 0.13;
      eyes.scale.y = 0.03 / 0.059;
    } else if (currentStatus === 'unknown' || currentStatus === 'stale') {
      eyes.scale.y = 0.023 / 0.059;
    } else if (currentStatus === 'completed') {
      // A short acknowledgement ends in a quiet, completed pose.
      const elapsed = transitionStart === null ? 2 : Math.max(0, time - transitionStart);
      arms[1].rotation.z = elapsed < 1.25 && !still ? -0.55 * Math.sin(Math.PI * elapsed / 1.25) : 0;
    }
  }

  function animate(timeSeconds, { moving = false, reducedMotion: staticFrame = reducedMotion } = {}) {
    if (disposed) return;
    const time = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    if (transitionStart === null) transitionStart = time;
    pose(time, moving, Boolean(staticFrame));
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    object.removeFromParent();
    object.clear();
    ownedGeometries.forEach((geometry) => geometry.dispose());
    releaseResources(resources);
  }

  setStatus(status);
  return { object, setStatus, animate, dispose };
}
