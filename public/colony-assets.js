import * as THREE from '/vendor/three.module.js';

// Original procedural models. Shared resources belong to the renderer, never to
// individual buildings: removing one work site cannot dispose another site's mesh.
export class ColonyAssets {
  constructor() { this.geometries = new Map(); this.materials = new Map(); }
  geometry(key, factory) {
    if (!this.geometries.has(key)) this.geometries.set(key, factory());
    return this.geometries.get(key);
  }
  material(color, options = {}) {
    const key = `${color}:${JSON.stringify(options)}`;
    if (!this.materials.has(key)) {
      if (this.lowPower) {
        const { roughness, metalness, ...lambertOptions } = options;
        this.materials.set(key, new THREE.MeshLambertMaterial({ color, ...lambertOptions }));
      } else this.materials.set(key, new THREE.MeshStandardMaterial({ color, roughness: .78, metalness: .04, ...options }));
    }
    return this.materials.get(key);
  }
  mesh(geometry, color, options = {}) {
    const mesh = new THREE.Mesh(geometry, this.material(color, options));
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }
  cylinder(rt, rb, height, color, sides = 12, options) {
    return this.mesh(this.geometry(`c:${rt}:${rb}:${height}:${sides}`, () => new THREE.CylinderGeometry(rt, rb, height, sides)), color, options);
  }
  box(x, y, z, color, options) {
    return this.mesh(this.geometry(`b:${x}:${y}:${z}`, () => new THREE.BoxGeometry(x, y, z)), color, options);
  }
  sphere(radius, color, hemisphere = false, options) {
    return this.mesh(this.geometry(`s:${radius}:${hemisphere}`, () => new THREE.SphereGeometry(radius, 16, 8, 0, Math.PI * 2, 0, hemisphere ? Math.PI / 2 : Math.PI)), color, options);
  }
  line(points, color, opacity = 1, loop = false) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    // Lines have different ownership from the reusable primitive meshes.
    const line = new (loop ? THREE.LineLoop : THREE.Line)(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
    line.userData.ownedResource = true;
    return line;
  }
  platform(color) {
    const group = new THREE.Group();
    const underside = this.cylinder(5.025, 4.95, .23, '#536064', 6); underside.position.y = .1; group.add(underside);
    const trim = this.cylinder(5.015, 5.015, .075, color, 6); trim.position.y = .235; group.add(trim);
    const surface = this.cylinder(4.94, 4.94, .045, '#d6dbd1', 6); surface.position.y = .295; group.add(surface);
    const hex = Array.from({ length: 6 }, (_, index) => { const a = index * Math.PI / 3; return new THREE.Vector3(Math.sin(a) * 4.79, .324, Math.cos(a) * 4.79); });
    group.add(this.line(hex, '#626f69', .7, true));
    // Clipped deck panel seams, subtle enough to keep activity legible.
    const maxX = 4.94 * Math.sqrt(3) / 2;
    for (let i = -3; i <= 3; i++) {
      const x = i * 1.08, z = 4.94 - Math.abs(x) / Math.sqrt(3);
      group.add(this.line([new THREE.Vector3(x, .322, -z), new THREE.Vector3(x, .322, z)], '#939f95', .33));
    }
    for (let i = -4; i <= 4; i++) {
      const z = i * 1.04, x = Math.min(maxX, (4.94 - Math.abs(z)) * Math.sqrt(3));
      group.add(this.line([new THREE.Vector3(-x, .322, z), new THREE.Vector3(x, .322, z)], '#939f95', .33));
    }
    // Small deck inset plates at the junctions feel manufactured, not decorative.
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const plate = this.box(.27, .025, .58, '#eef2e7');
      plate.position.set(Math.sin(a) * 4.42, .335, Math.cos(a) * 4.42); plate.rotation.y = a; group.add(plate);
      const light = this.box(.16, .03, .13, color, { emissive: color, emissiveIntensity: .12 });
      light.position.set(Math.sin(a) * 4.42, .355, Math.cos(a) * 4.42); light.rotation.y = a; group.add(light);
    }
    return group;
  }
  headquarters(color, variant = 0) {
    const group = new THREE.Group();
    const foot = this.cylinder(1.14, 1.2, .16, '#6b797b'); foot.position.y = .08; group.add(foot);
    const skirt = this.cylinder(1.04, 1.12, .17, '#f6f4e9'); skirt.position.y = .24; group.add(skirt);
    const body = this.cylinder(.98, 1.02, .76, '#edf2ec'); body.position.y = .65; group.add(body);
    const band = this.cylinder(1.035, 1.035, .12, color); band.position.y = .9; group.add(band);
    const rim = this.cylinder(1.04, 1.04, .14, '#f9fbf2'); rim.position.y = 1.04; group.add(rim);
    const dome = this.sphere(.9, color, true, { roughness: .49, metalness: .16 }); dome.position.y = 1.12; group.add(dome);
    const cap = this.cylinder(.2, .29, .14, '#f2f5ed'); cap.position.y = 2.02; group.add(cap);
    for (let index = 0; index < 7; index++) {
      const angle = index / 7 * Math.PI * 2 + .2;
      const window = this.box(.3, .22, .055, '#37535a', { roughness: .5 });
      window.position.set(Math.sin(angle) * 1.015, .62, Math.cos(angle) * 1.015); window.rotation.y = angle; group.add(window);
    }
    const door = this.box(.43, .57, .09, '#344c55'); door.position.set(0, .52, 1.02); group.add(door);
    const lintel = this.box(.57, .09, .2, color); lintel.position.set(0, .83, 1.07); group.add(lintel);
    const ramp = this.box(.61, .09, .52, '#edf1e6'); ramp.position.set(0, .08, 1.29); ramp.rotation.x = -.15; group.add(ramp);
    const mast = this.cylinder(.035, .05, .78, '#687b7e', 6); mast.position.set(.67, 1.54, -.48); group.add(mast);
    const antenna = this.sphere(.1, '#e1c878'); antenna.position.set(.67, 1.98, -.48); group.add(antenna);
    if (variant % 2) {
      const annex = this.cylinder(.47, .56, .47, '#f4f7ef', 8); annex.position.set(-1.03, .33, -.18); group.add(annex);
      const roof = this.cylinder(.52, .52, .13, color, 8); roof.position.set(-1.03, .63, -.18); group.add(roof);
    } else {
      const receiver = this.sphere(.33, '#f4f7ef', true); receiver.rotation.z = -.55; receiver.position.set(-.72, 1.37, -.6); group.add(receiver);
    }
    return group;
  }
  workstation(color, index = 0) {
    const group = new THREE.Group();
    const foot = this.cylinder(.8, .84, .11, '#617375', 8); foot.position.y = .055; group.add(foot);
    const base = this.cylinder(.72, .78, .24, '#f4f5eb', 8); base.position.y = .23; group.add(base);
    const body = this.cylinder(.66, .71, .42, '#f1f5ec', 8); body.position.y = .54; group.add(body);
    const band = this.cylinder(.705, .705, .12, color, 8); band.position.y = .65; group.add(band);
    const roof = this.cylinder(.75, .75, .12, '#f7f8ef', 8); roof.position.y = .81; group.add(roof);
    const inset = this.cylinder(.47, .47, .045, '#526e75', 8); inset.position.y = .895; group.add(inset);
    if (index % 3 === 0) {
      const core = this.sphere(.37, color, true); core.position.y = .91; group.add(core);
    } else {
      const cartridge = this.box(.4, .29, .4, color); cartridge.position.set(-.09, 1.05, 0); cartridge.rotation.y = -.15; group.add(cartridge);
      const lid = this.box(.43, .07, .43, '#f7f9f0'); lid.position.set(-.09, 1.22, 0); lid.rotation.y = -.15; group.add(lid);
    }
    for (const x of [-.3, .3]) {
      const window = this.box(.18, .2, .04, '#3e5860'); window.position.set(x, .5, .66); group.add(window);
    }
    const console = this.box(.5, .35, .32, '#eef3eb'); console.position.set(.03, .23, 1.02); group.add(console);
    const screen = this.box(.36, .22, .035, '#3c686b'); screen.position.set(.03, .43, 1.13); screen.rotation.x = -.45; group.add(screen);
    const key = this.box(.13, .04, .1, color); key.position.set(.03, .43, 1.29); group.add(key);
    // A paired supply canister adds scale and hand-made industrial detail.
    for (const x of [-.2, .2]) {
      const supply = this.cylinder(.13, .13, .24, '#e6ede4', 8); supply.position.set(-.98 + x, .12, -.32); group.add(supply);
      const lid = this.cylinder(.14, .14, .055, color, 8); lid.position.set(-.98 + x, .27, -.32); group.add(lid);
    }
    return group;
  }
  launchpad(color) {
    const group = new THREE.Group();
    const base = this.cylinder(.83, .9, .06, '#60736f', 12); base.position.y = .03; group.add(base);
    const deck = this.cylinder(.75, .75, .025, '#c4d0c4', 12); deck.position.y = .074; group.add(deck);
    const points = Array.from({ length: 33 }, (_, i) => new THREE.Vector3(Math.sin(i / 32 * Math.PI * 2) * .57, .092, Math.cos(i / 32 * Math.PI * 2) * .57));
    group.add(this.line(points, '#f0f3dd', 1));
    const a = this.box(.08, .017, .53, '#f4f5e8'); a.position.set(-.14, .093, 0); group.add(a);
    const b = this.box(.08, .017, .53, '#f4f5e8'); b.position.set(.14, .093, 0); group.add(b);
    const c = this.box(.3, .017, .075, '#f4f5e8'); c.position.y = .093; group.add(c);
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const light = this.cylinder(.065, .065, .08, color, 8); light.position.set(Math.sin(a) * .78, .105, Math.cos(a) * .78); group.add(light);
    }
    return group;
  }
  tree(scale = 1, variant = 0) {
    const group = new THREE.Group();
    const trunk = this.cylinder(.055, .09, .65, '#68715a', 6); trunk.position.y = .3; group.add(trunk);
    if (variant % 3) {
      const crown = this.sphere(.52, variant % 2 ? '#708f64' : '#819a6d'); crown.scale.set(1, .65, 1); crown.position.y = .87; group.add(crown);
      const top = this.sphere(.3, '#8ca775'); top.scale.y = .6; top.position.set(-.12, 1.08, -.08); group.add(top);
    } else {
      const cone = this.mesh(this.geometry('treecone', () => new THREE.ConeGeometry(.46, 1.15, 6)), '#66866c'); cone.position.y = 1.04; group.add(cone);
      const cone2 = this.mesh(this.geometry('treecone2', () => new THREE.ConeGeometry(.36, .8, 6)), '#789a78'); cone2.position.y = 1.48; group.add(cone2);
    }
    group.scale.setScalar(scale); return group;
  }
  optimize(group) {
    // Bake static primitives by material within one selectable entity. This
    // preserves entity-level picking while keeping a little colony inexpensive.
    group.updateMatrixWorld(true);
    const inverse = group.matrixWorld.clone().invert(), buckets = new Map(), lines = new Map(), removals = [];
    group.traverse(object => {
      if (object.isMesh && !Array.isArray(object.material)) {
        const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
        geometry.applyMatrix4(inverse.clone().multiply(object.matrixWorld));
        if (!buckets.has(object.material.uuid)) buckets.set(object.material.uuid, { material: object.material, geometries: [] });
        buckets.get(object.material.uuid).geometries.push(geometry); removals.push(object);
      } else if (object.isLine && object.userData.ownedResource) {
        const key = `${object.material.color.getHex()}:${object.material.opacity}`;
        if (!lines.has(key)) lines.set(key, { material: object.material.clone(), vertices: [] });
        const bucket = lines.get(key), attribute = object.geometry.getAttribute('position');
        const transform = inverse.clone().multiply(object.matrixWorld), points = [];
        for (let i = 0; i < attribute.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(attribute, i).applyMatrix4(transform));
        const count = object.isLineLoop ? points.length : points.length - 1;
        for (let i = 0; i < count; i++) bucket.vertices.push(...points[i].toArray(), ...points[(i + 1) % points.length].toArray());
        removals.push(object);
      }
    });
    for (const object of removals) {
      object.removeFromParent();
      if (object.userData.ownedResource) { object.geometry.dispose(); object.material.dispose(); }
    }
    for (const bucket of buckets.values()) {
      const geometry = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'uv']) {
        if (!bucket.geometries.every(part => part.hasAttribute(name))) continue;
        const attributes = bucket.geometries.map(part => part.getAttribute(name));
        const values = new Float32Array(attributes.reduce((sum, attribute) => sum + attribute.array.length, 0));
        let offset = 0; for (const attribute of attributes) { values.set(attribute.array, offset); offset += attribute.array.length; }
        geometry.setAttribute(name, new THREE.BufferAttribute(values, attributes[0].itemSize));
      }
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, bucket.material); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.ownedGeometry = true; group.add(mesh);
      for (const part of bucket.geometries) part.dispose();
    }
    for (const bucket of lines.values()) {
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.vertices, 3));
      const line = new THREE.LineSegments(geometry, bucket.material); line.userData.ownedResource = true; group.add(line);
    }
    return group;
  }
  release(group) {
    group.traverse(object => {
      if (object.userData.ownedResource) { object.geometry?.dispose(); object.material?.dispose(); }
      else if (object.userData.ownedGeometry) object.geometry?.dispose();
    });
  }
  dispose() {
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear(); this.materials.clear();
  }
}
