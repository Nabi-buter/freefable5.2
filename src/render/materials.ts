import * as THREE from 'three';

/** Shared uniforms updated once per frame. */
export const shared = {
  uTime: { value: 0 },
  uGlowMul: { value: 1 },
  /** terrain height texture + world extent, used by ground decals */
  uHeightMap: { value: null as THREE.Texture | null },
  uHeightExtent: { value: 170 },
  /** see-through hole around the player: x, y (framebuffer px), radius (px), depth (0..1) */
  uCut: { value: new THREE.Vector4(0, 0, 0, 1) },
};

export interface WorldMatOpts {
  sway?: boolean;
  instFx?: boolean;
  /** dither away fragments that stand between the camera and the player */
  cutout?: boolean;
  /** use the mesh normals instead of faceted shading (soft things like grass) */
  smooth?: boolean;
  color?: number;
  side?: THREE.Side;
  transparent?: boolean;
}

/**
 * Low-poly lit material with vertex colours plus:
 *  - aGlow   : per-vertex emissive amount (emits the vertex colour)
 *  - aSway   : per-vertex wind / wobble weight
 *  - aFx     : per-instance (flash, telegraph, frozen, elite)   [instFx]
 *  - aPhase  : per-instance animation phase                     [instFx]
 */
export function makeWorldMat(o: WorldMatOpts = {}): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: !o.smooth,
    color: o.color ?? 0xffffff,
    side: o.side ?? THREE.FrontSide,
    transparent: o.transparent ?? false,
  });
  mat.defines = {};
  if (o.sway) mat.defines.USE_SWAY = '';
  if (o.instFx) mat.defines.USE_INSTFX = '';
  if (o.cutout) mat.defines.USE_CUTOUT = '';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = shared.uTime;
    sh.uniforms.uGlowMul = shared.uGlowMul;
    sh.uniforms.uCut = shared.uCut;
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float aGlow;
varying float vGlow;
#if defined(USE_SWAY) || defined(USE_INSTFX)
attribute float aSway;
uniform float uTime;
#endif
#ifdef USE_INSTFX
attribute vec4 aFx;
attribute float aPhase;
varying vec4 vFx;
#endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
vGlow = aGlow;
#ifdef USE_INSTFX
  vFx = aFx;
  if (aSway > 0.0) {
    transformed.x += aSway * sin(aPhase + position.y * 2.0) * 0.16;
    transformed.z += aSway * cos(aPhase * 0.8 + position.y * 1.7) * 0.11;
  } else if (aSway < 0.0) {
    transformed.y += max(0.0, sin(aPhase * 2.0 + sign(position.z) * 1.5708 + position.x * 2.0)) * 0.24 * (-aSway);
  }
#elif defined(USE_SWAY)
  #ifdef USE_INSTANCING
    vec3 swp = (instanceMatrix * vec4(position, 1.0)).xyz;
  #else
    vec3 swp = position;
  #endif
  float swv = sin(uTime * 1.3 + swp.x * 0.35 + swp.z * 0.27) + 0.5 * sin(uTime * 2.7 + swp.x * 0.8 - swp.z * 0.6);
  transformed.x += aSway * swv * 0.075;
  transformed.z += aSway * swv * 0.05;
#endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vGlow;
uniform float uGlowMul;
#ifdef USE_CUTOUT
uniform vec4 uCut;
#endif
#ifdef USE_INSTFX
varying vec4 vFx;
#endif`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
#ifdef USE_CUTOUT
  if (uCut.z > 0.0 && gl_FragCoord.z < uCut.w) {
    vec2 cd = (gl_FragCoord.xy - uCut.xy) / uCut.z;
    cd.y *= 0.82;
    float cr = length(cd);
    if (cr < 1.0) {
      float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (ign > smoothstep(0.5, 1.0, cr) * 1.05) discard;
    }
  }
#endif`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
#ifdef USE_INSTFX
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.5, 0.78, 1.0), vFx.z * 0.7);
#endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += vColor.rgb * vGlow * uGlowMul;
#ifdef USE_INSTFX
  totalEmissiveRadiance += vColor.rgb * vGlow * vFx.y * 3.0 + vec3(1.0, 0.22, 0.2) * vFx.y * 0.3;
  totalEmissiveRadiance += vec3(1.0, 0.95, 0.85) * vFx.x * 1.1;
  totalEmissiveRadiance += vec3(1.0, 0.72, 0.2) * vFx.w * 0.4;
  totalEmissiveRadiance += vec3(0.25, 0.5, 0.9) * vFx.z * 0.25;
#endif`,
      );
  };
  return mat;
}

/** GLSL shared by ground-hugging decals: sample terrain height at a world xz position. */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeightMap;
uniform float uHeightExtent;
float terrainH(vec2 xz) {
  vec2 uv = xz / (uHeightExtent * 2.0) + 0.5;
  return texture2D(uHeightMap, uv).r;
}
`;

/** unlit HDR colour (values above 1 feed the bloom pass) */
export function glowMat(r: number, g: number, b: number, opts: { additive?: boolean; opacity?: number; side?: THREE.Side; depthWrite?: boolean } = {}): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(r, g, b),
    transparent: opts.additive || (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: opts.depthWrite ?? !opts.additive,
    side: opts.side ?? THREE.FrontSide,
    fog: false,
  });
  return m;
}

export function hexRGB(hex: number, mul = 1): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r * mul, c.g * mul, c.b * mul];
}
