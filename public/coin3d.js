// 3D-монета на Three.js: металл с отражениями, гурт по ребру, наклон к точке тапа и раскрутка при быстрых тапах
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function faceTexture(letter) {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), m = S / 2;
  // основа: мягкий радиальный перелив
  const base = g.createRadialGradient(m * .8, m * .7, 40, m, m, m);
  base.addColorStop(0, '#ffffff'); base.addColorStop(.6, '#d8d8d8'); base.addColorStop(1, '#a8a8a8');
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  // внешний бортик
  g.lineWidth = 46; g.strokeStyle = '#f4f4f4';
  g.beginPath(); g.arc(m, m, m - 30, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 6; g.strokeStyle = '#8c8c8c';
  g.beginPath(); g.arc(m, m, m - 56, 0, Math.PI * 2); g.stroke();
  // кольцо из бусин
  g.fillStyle = '#ececec';
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * Math.PI * 2;
    g.beginPath(); g.arc(m + Math.cos(a) * (m - 92), m + Math.sin(a) * (m - 92), 9, 0, Math.PI * 2); g.fill();
  }
  // внутреннее кольцо
  g.lineWidth = 10; g.strokeStyle = '#f6f6f6';
  g.beginPath(); g.arc(m, m, m - 130, 0, Math.PI * 2); g.stroke();
  // лучи
  g.save(); g.translate(m, m);
  for (let i = 0; i < 24; i++) {
    g.rotate(Math.PI / 12);
    g.fillStyle = i % 2 ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.06)';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(-30, -(m - 140)); g.lineTo(30, -(m - 140)); g.closePath(); g.fill();
  }
  g.restore();
  // буква-эмблема с «чеканкой»
  g.font = `900 ${S * .46}px "Unbounded", "Arial Black", system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // крышка цилиндра повёрнута на 90° относительно камеры — рисуем букву с поправкой
  g.save(); g.translate(m, m); g.rotate(-Math.PI / 2);
  g.fillStyle = '#7a7a7a'; g.fillText(letter, 10, 26);
  g.fillStyle = '#ffffff'; g.fillText(letter, 0, 16);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function edgeTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 32;
  const g = c.getContext('2d');
  for (let x = 0; x < 1024; x += 8) {
    g.fillStyle = '#e8e8e8'; g.fillRect(x, 0, 5, 32);
    g.fillStyle = '#9a9a9a'; g.fillRect(x + 5, 0, 3, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.repeat.set(2, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createCoin(container, { color = '#f2c14e', letter = 'G' } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 5.4);

  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(2, 3, 4); scene.add(key);
  const front = new THREE.DirectionalLight(0xfff4dc, 2.6); front.position.set(-.6, .4, 5); scene.add(front);
  const rim = new THREE.DirectionalLight(0x7aa8ff, 1.4); rim.position.set(-3, -1, -2); scene.add(rim);
  scene.add(new THREE.AmbientLight(0xffffff, 0.25));

  const faceMap = faceTexture(letter);
  const faceMat = new THREE.MeshPhysicalMaterial({ map: faceMap, bumpMap: faceMap, bumpScale: 2.2, metalness: .9, roughness: .32, clearcoat: .6, clearcoatRoughness: .2, emissiveIntensity: 1 });
  const edgeMap = edgeTexture();
  const edgeMat = new THREE.MeshPhysicalMaterial({ map: edgeMap, bumpMap: edgeMap, bumpScale: 1.5, metalness: 1, roughness: .35 });

  // Цилиндр: группы материалов — бок, верх, низ
  const geo = new THREE.CylinderGeometry(1, 1, .17, 128, 1);
  const coin = new THREE.Mesh(geo, [edgeMat, faceMat, faceMat]);
  coin.rotation.x = Math.PI / 2; // повернуть «лицом» к камере
  const pivot = new THREE.Group();
  pivot.add(coin);
  scene.add(pivot);

  function setSkin(hex) {
    const c = new THREE.Color(hex);
    faceMat.color.copy(c); edgeMat.color.copy(c).multiplyScalar(.92);
    const cosmic = hex.toLowerCase() === '#9b7bff';
    faceMat.emissive.set(cosmic ? 0x2a1466 : 0x000000);
    faceMat.iridescence = cosmic ? 1 : 0;
  }
  setSkin(color);

  // Пружинная физика наклона и сжатия
  const st = { tx: 0, ty: 0, vx: 0, vy: 0, ax: 0, ay: 0, s: 1, vs: 0, spin: 0, spinV: 0 };
  let t0 = performance.now(), running = true, visible = true;

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    if (!visible) return;
    const dt = Math.min(.05, (now - t0) / 1000); t0 = now;
    const t = now / 1000;
    // пружины: k — жёсткость, d — затухание
    const spring = (x, v, target, k, d) => { const a = (target - x) * k - v * d; v += a * dt; return [x + v * dt, v]; };
    [st.ax, st.vx] = spring(st.ax, st.vx, st.tx, 120, 12);
    [st.ay, st.vy] = spring(st.ay, st.vy, st.ty, 120, 12);
    [st.s, st.vs] = spring(st.s, st.vs, 1, 260, 14);
    st.tx *= Math.pow(.02, dt); st.ty *= Math.pow(.02, dt);
    st.spinV *= Math.pow(.35, dt);
    st.spin += st.spinV * dt;
    // когда раскрутка стихает, монета доворачивается лицом к игроку
    if (st.spinV < 1.2) st.spin += (Math.round(st.spin / Math.PI) * Math.PI - st.spin) * Math.min(1, dt * 5);
    pivot.rotation.x = st.ax + Math.sin(t * .9) * .05;
    pivot.rotation.y = st.ay + Math.sin(t * .6) * .28 + st.spin;
    pivot.position.y = Math.sin(t * 1.4) * .04;
    pivot.scale.setScalar(st.s);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; t0 = performance.now(); });

  return {
    // x, y — координаты тапа от -1 до 1 относительно центра монеты
    tap(x, y, strong) {
      st.tx = -y * .55; st.ty = x * .7;
      st.vs -= strong ? 7 : 5;
      st.spinV = Math.min(st.spinV + .9, 14);
    },
    setSkin,
    destroy() { running = false; renderer.dispose(); renderer.domElement.remove(); },
  };
}
