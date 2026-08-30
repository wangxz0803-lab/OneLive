import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const MODEL_URL = "assets/future/presenter-natural-lite.glb?v=20260830-24";
const PANORAMA_URL = "assets/future/shanghai-bund-360-v2.png?v=20260830-24";
const PRESENTER_GROUND_OFFSET = -0.75;
const RENDER_INTERVAL_MS = 1000 / 30;
const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

class OneLiveSpatialPlayer {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.ready = false;
    this.active = false;
    this.mode = "production";
    this.angle = 0;
    this.targetAngle = 0;
    this.pitch = 0;
    this.targetPitch = 0;
    this.radius = 6.35;
    this.frame = 0;
    this.lastTime = performance.now();
    this.lastRenderTime = 0;
    this.network = "good";
    this.qod = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 150);
    this.camera.position.set(0, 1.52, this.radius);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = false;
    this.renderer.domElement.setAttribute("aria-label", "预生成三维人物实时渲染视图");
    this.renderer.domElement.setAttribute("role", "img");
    container.appendChild(this.renderer.domElement);

    new THREE.TextureLoader().load(PANORAMA_URL, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.anisotropy = Math.min(2, this.renderer.capabilities.getMaxAnisotropy());
      // Shift the equirectangular sampling window downward without tilting the
      // sphere itself. This keeps the promenade visible while preserving a
      // level horizon through the full 360-degree yaw.
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.offset.y = -0.155;
      texture.needsUpdate = true;
      const panorama = new THREE.Mesh(
        new THREE.SphereGeometry(60, 48, 24),
        new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff, side: THREE.BackSide, fog: false })
      );
      panorama.rotation.x = 0;
      panorama.rotation.y = THREE.MathUtils.degToRad(130);
      this.scene.add(panorama);
      this.panorama = panorama;
      this.panoramaBaseRotationY = panorama.rotation.y;
    });

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.62, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.minDistance = 4.6;
    this.controls.maxDistance = 8.4;
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(64);
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(104);
    this.controls.enabled = false;
    this.controls.update();

    // Dragging requests a real orbit around the shared world origin. The
    // presenter and panorama remain fixed in world space; relative change is
    // produced by the camera position instead of rotating two unrelated layers.
    this.pointerOrbit = null;
    this.onPointerDown = (event) => {
      if (this.mode !== "viewer" || !this.ready) return;
      this.pointerOrbit = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        angle: this.targetAngle,
        pitch: this.targetPitch,
      };
      this.renderer.domElement.setPointerCapture?.(event.pointerId);
      this.renderer.domElement.style.cursor = "grabbing";
    };
    this.onPointerMove = (event) => {
      if (!this.pointerOrbit || this.pointerOrbit.id !== event.pointerId) return;
      const width = Math.max(1, this.renderer.domElement.clientWidth);
      const height = Math.max(1, this.renderer.domElement.clientHeight);
      const next = THREE.MathUtils.clamp(
        this.pointerOrbit.angle + ((event.clientX - this.pointerOrbit.x) / width) * 360,
        -180,
        180
      );
      const nextPitch = THREE.MathUtils.clamp(
        this.pointerOrbit.pitch - ((event.clientY - this.pointerOrbit.y) / height) * 90,
        -10,
        32
      );
      this.targetAngle = next;
      this.targetPitch = nextPitch;
      this.callbacks.onAngleRequest?.(Math.round(next));
      this.callbacks.onPitchRequest?.(Math.round(nextPitch));
    };
    this.onPointerUp = (event) => {
      if (!this.pointerOrbit || this.pointerOrbit.id !== event.pointerId) return;
      this.pointerOrbit = null;
      this.renderer.domElement.releasePointerCapture?.(event.pointerId);
      this.renderer.domElement.style.cursor = this.mode === "viewer" ? "grab" : "default";
    };
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerUp);

    const hemisphere = new THREE.HemisphereLight(0x9fc9e6, 0x211812, 1.1);
    this.scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffe2bc, 2.1);
    key.position.set(-3.2, 5.4, 4.4);
    // The current scene uses a lightweight contact shadow instead of a full
    // shadow map. This removes one complete render pass on presentation PCs.
    key.castShadow = false;
    key.target.position.set(0, 1.25, 0);
    this.scene.add(key.target);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x76bfe8, 0.82);
    fill.position.set(3.8, 2.5, -2.7);
    this.scene.add(fill);
    const rim = new THREE.PointLight(0xffb66c, 3.6, 9, 2);
    rim.position.set(-2.3, 2.1, 1.2);
    this.scene.add(rim);

    // A compact contact shadow follows the same panorama-space anchor.
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = shadowCanvas.height = 256;
    const shadowContext = shadowCanvas.getContext("2d");
    const shadowGradient = shadowContext.createRadialGradient(128, 128, 12, 128, 128, 124);
    shadowGradient.addColorStop(0, "rgba(0,0,0,.62)");
    shadowGradient.addColorStop(.46, "rgba(0,0,0,.28)");
    shadowGradient.addColorStop(1, "rgba(0,0,0,0)");
    shadowContext.fillStyle = shadowGradient;
    shadowContext.fillRect(0, 0, 256, 256);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.9, 1.12),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false })
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, PRESENTER_GROUND_OFFSET + 0.012, 0.08);
    this.scene.add(contactShadow);
    this.contactShadow = contactShadow;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.load();
    this.tick = this.tick.bind(this);
    this.frame = requestAnimationFrame(this.tick);
  }

  load() {
    const loader = new GLTFLoader();
    const onProgress = (event) => {
      if (!event.total) return;
      this.callbacks.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    const finish = (model, animations = []) => {
        model.traverse((node) => {
          if (!node.isMesh) return;
          node.castShadow = false;
          node.receiveShadow = false;
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          materials.filter(Boolean).forEach((material) => {
            if ("roughness" in material) material.roughness = 0.52;
            if ("metalness" in material) material.metalness = Math.min(0.25, material.metalness || 0);
            material.side = THREE.DoubleSide;
            material.needsUpdate = true;
          });
        });

        const sourceClip = animations[0];
        if (sourceClip) {
          this.mixer = new THREE.AnimationMixer(model);
          this.action = this.mixer.clipAction(sourceClip);
          this.action.setLoop(THREE.LoopRepeat, Infinity).play();
          this.mixer.setTime(0);
        }

        model.updateMatrixWorld(true);
        let box = new THREE.Box3().setFromObject(model);
        const height = Math.max(1, box.max.y - box.min.y);
        const scale = 5.25 / height;
        model.scale.setScalar(scale);
        model.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.x -= center.x;
        model.position.y += PRESENTER_GROUND_OFFSET - box.min.y;
        model.position.z -= center.z;
        model.updateMatrixWorld(true);
        this.scene.add(model);
        this.model = model;
        this.modelBaseRotationY = model.rotation.y;
        this.ready = true;
        this.container.classList.remove("is-loading", "is-error");
        this.container.classList.add("is-ready");
        this.callbacks.onReady?.({ clips: animations.length, duration: sourceClip?.duration || 0, fallback: false });
        this.resize();
    };
    const fail = (error) => {
      this.container.classList.remove("is-loading", "is-ready");
      this.container.classList.add("is-error");
      this.callbacks.onError?.(error);
    };
    loader.load(MODEL_URL, (gltf) => finish(gltf.scene, gltf.animations), onProgress, fail);
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.applyQuality();
  }

  applyQuality() {
    // 1.25x keeps the 3D view sharp on a projector while avoiding a 2-4x
    // fragment workload on high-DPI laptops.
    const goodRatio = Math.min(window.devicePixelRatio || 1, 1.25);
    let ratio = goodRatio;
    if (this.network === "congested") ratio = this.qod ? Math.min(goodRatio, 1.1) : 0.72;
    if (this.network === "weak") ratio = this.qod ? 0.9 : 0.58;
    this.renderer.setPixelRatio(ratio);
  }

  setNetwork(network, qod) {
    this.network = network;
    this.qod = qod;
    this.applyQuality();
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = mode === "viewer" && this.ready ? "grab" : "default";
    this.renderer.domElement.tabIndex = mode === "viewer" ? 0 : -1;
  }

  setActive(active) {
    this.active = active;
    if (active) {
      this.lastTime = performance.now();
      this.lastRenderTime = 0;
    }
  }

  setAngle(angle, immediate = false) {
    this.targetAngle = THREE.MathUtils.clamp(Number(angle) || 0, -180, 180);
    if (immediate) this.angle = this.targetAngle;
  }

  setPitch(pitch, immediate = false) {
    this.targetPitch = THREE.MathUtils.clamp(Number(pitch) || 0, -10, 32);
    if (immediate) this.pitch = this.targetPitch;
  }

  resetView() {
    this.controls.target.set(0, 1.62, 0);
    this.camera.position.set(0, 1.52, this.radius);
    this.angle = this.targetAngle = 0;
    this.pitch = this.targetPitch = 0;
    if (this.model) this.model.rotation.y = this.modelBaseRotationY || 0;
    this.controls.update();
    this.callbacks.onAngleRequest?.(0);
    this.callbacks.onPitchRequest?.(0);
  }

  tick(now) {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.active || document.hidden || !this.container.isConnected) return;
    if (this.lastRenderTime && now - this.lastRenderTime < RENDER_INTERVAL_MS) return;
    this.lastRenderTime = now;
    const delta = Math.min(0.05, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;
    if (this.ready && this.mixer && !REDUCED_MOTION.matches) this.mixer.update(delta);

    const ease = REDUCED_MOTION.matches ? 1 : Math.min(1, delta * 8);
    const angleDelta = ((this.targetAngle - this.angle + 540) % 360) - 180;
    this.angle += angleDelta * ease;
    this.angle = ((this.angle + 540) % 360) - 180;
    this.pitch += (this.targetPitch - this.pitch) * ease;
    if (this.model) this.model.rotation.y = this.modelBaseRotationY || 0;
    if (this.panorama) this.panorama.rotation.y = this.panoramaBaseRotationY || 0;
    const radians = THREE.MathUtils.degToRad(this.angle);
    const elevation = THREE.MathUtils.degToRad(this.pitch - 0.9);
    const horizontalRadius = Math.cos(elevation) * this.radius;
    this.camera.position.set(
      Math.sin(radians) * horizontalRadius,
      this.controls.target.y + Math.sin(elevation) * this.radius,
      Math.cos(radians) * horizontalRadius
    );
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointercancel", this.onPointerUp);
    this.controls.dispose();
    this.renderer.dispose();
  }
}

window.OneLiveSpatial3D = {
  create(container, callbacks) {
    if (!container || !window.WebGLRenderingContext) throw new Error("WebGL unavailable");
    return new OneLiveSpatialPlayer(container, callbacks);
  }
};
