
/* ============================================================================
 *  RENDERING (WebGL2): shaders
 * ========================================================================== */
const INST_PER_ROW = 256;                // pieces per row of the per-instance data texture (a power of two)
// MARBLE_SHADOWS (a #define set by compilePrograms from the GPU's uniform budget): how many marbles cast soft
// shadows at once. Any number of marbles is drawn; the rolling ones come first in the shadow list.
// Sunlight comes in through a window: a lit parallelogram with mullion shadows, projected along the sun direction
// (shared by every shader that is lit by the sun; the marbles evaluate it per vertex). On a tower the window is as
// tall as the tower: the patch's gentle top-left-to-bottom-right fall-off is folded (a smooth wave along v), so every
// storey of the tower gets the same warm light instead of the lower storeys fading to the skylight.
const GLSL_WINDOW = `
uniform vec4 uWinU;      // xyz: window-plane axis across the sun direction, w: offset (world -> window plane)
uniform vec4 uWinV;      // xyz: window-plane axis up the window, w: offset
uniform vec4 uWinRect;   // the lit rectangle in window-plane units: u0, v0, u1, v1
uniform vec4 uWinBars;   // x: u of the upright mullion, y: v of the transom, z: half bar width, w: penumbra per unit of depth
uniform vec4 uWinFold;   // x: fold period in v (0: none), y: v at the board's top
float windowCookie(vec3 wp, vec3 sunDir) {
  float u = dot(wp, uWinU.xyz) + uWinU.w, v = dot(wp, uWinV.xyz) + uWinV.w;
  if (uWinFold.x > 0.0) v = uWinFold.y - uWinFold.x * (0.5 - 0.5 * cos(3.14159265 * (uWinFold.y - v) / uWinFold.x));
  float d = max(uWinBars.w * (900.0 - dot(wp, sunDir)), 1.5);   // the farther from the window, the softer the edge
  float lit = smoothstep(uWinRect.x - d, uWinRect.x + d, u) * smoothstep(uWinRect.z + d, uWinRect.z - d, u)
            * smoothstep(uWinRect.y - d, uWinRect.y + d, v) * smoothstep(uWinRect.w + d, uWinRect.w - d, v);
  float bu = smoothstep(uWinBars.z - d, uWinBars.z + d, abs(u - uWinBars.x));
  float bv = smoothstep(uWinBars.z - d, uWinBars.z + d, abs(v - uWinBars.y));
  float fall = mix(1.25, 0.35, smoothstep(-400.0, 800.0, u - 0.35 * v));   // the patch is brightest up on the left and fades to the lower right
  return mix(0.3, 1.0, lit * (1.0 - 0.6 * (1.0 - bu)) * bv * fall);   // (the mullion's soft shadow); outside the patch: skylight
}
`;
const GLSL_COMMON = GLSL_WINDOW + `
const float PI = 3.14159265;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSH[9];
uniform samplerCube uEnv;
uniform float uEnvMax;
uniform sampler2D uShadow0;
uniform sampler2D uShadow1;
uniform sampler2DShadow uShadowCmp0;
uniform sampler2DShadow uShadowCmp1;
uniform mat4 uShadowMat0;
uniform mat4 uShadowMat1;
uniform vec4 uShadowInfo0;     // x: frustum width (units), y: depth range, z: texel (uv), w: normal offset
uniform vec4 uShadowInfo1;
uniform float uLightTan;       // tan of the key light's angular radius (penumbra growth)
uniform int uTaps;             // shadow taps for this draw (big soft receivers use fewer)
uniform vec4 uMarbles[MARBLE_SHADOWS];
uniform vec4 uMarbleCol[MARBLE_SHADOWS];   // rgb: glass tint, a: fade
uniform ivec2 uMarbleRange;    // which marbles can shade this draw: [x, y) (rolling ones for the board, the cup pile for the desk...)
uniform float uTime;

vec3 shIrradiance(vec3 n) {
  float x = n.x, y = n.y, z = n.z;
  vec3 e = uSH[0] * 0.282095 * PI
    + (uSH[1] * (0.488603 * y) + uSH[2] * (0.488603 * z) + uSH[3] * (0.488603 * x)) * (2.0 * PI / 3.0)
    + (uSH[4] * (1.092548 * x * y) + uSH[5] * (1.092548 * y * z) + uSH[6] * (0.315392 * (3.0 * z * z - 1.0))
       + uSH[7] * (1.092548 * x * z) + uSH[8] * (0.546274 * (x * x - y * y))) * (PI / 4.0);
  return max(e, vec3(0.0));
}
float D_GGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float V_Smith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2), gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / (gv + gl + 1e-5);
}
vec3 F_Schlick(vec3 f0, float c) { float f = pow(1.0 - c, 5.0); return f0 + (1.0 - f0) * f; }
vec3 envBRDF(vec3 f0, float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 AB = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * AB.x + AB.y;
}
vec4 envSpec4(vec3 R, float rough) { return textureLod(uEnv, R, rough * uEnvMax); }
vec3 envSpec(vec3 R, float rough) { return envSpec4(R, rough).rgb; }
// the cube's alpha is the room's luminance as a mirror (chrome, glass) sees it, a dim room with bright features (see envRadiance):
// the plain room's colour at that luminance. (The colour is divided by the luminance sampled with it, so the two interpolate
// as a tint and a level and no hairline of the plain room's survives into the mirror room.)
vec3 envMirror(vec4 e) { return e.rgb * (e.a / max(dot(e.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.02)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Percentage-closer soft shadows: blocker search on raw depth, then hardware-bilinear PCF whose
// radius grows with the blocker distance (sharp at contact, soft far away).
// NoL (geometric normal . sun) sets a receiver slope bias and the normal offset; extra adds bias in texels.
float pcss(sampler2D sm, sampler2DShadow smc, mat4 smat, vec4 info, vec3 wp, vec3 n, float NoL, float extra, float rnd, out bool inside) {
  NoL = clamp(NoL, 0.0, 1.0);
  vec4 sc = smat * vec4(wp + n * info.w * (1.3 - NoL), 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  inside = c.x > 0.002 && c.x < 0.998 && c.y > 0.002 && c.y < 0.998 && c.z < 1.0;
  if (!inside) return 1.0;
  float slope = sqrt(1.0 - NoL * NoL) / max(NoL, 0.2);
  float zr = c.z - info.z * (0.5 + 1.5 * slope + extra);
  float ang = rnd * 6.2831853;
  mat2 rot = mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
  float sr = max(uLightTan * 170.0 / info.x, 3.0 * info.z);
  float bsum = 0.0, bn = 0.0;
  int nb = min(BLOCKER_SAMPLES, max(uTaps, 3));
  for (int i = 0; i < BLOCKER_SAMPLES; i++) {
    if (i >= nb) break;
    float fi = float(i) + 0.5;
    vec2 o = rot * vec2(cos(fi * 2.39996), sin(fi * 2.39996)) * (fi / float(nb)) * sr;   // (taps spread evenly in radius, not in area: a thin occluder just beside the pixel is found, where an area-uniform search over the whole penumbra range missed it and left lit dots in its shadow)
    float d = texture(sm, c.xy + o).r;
    if (d < zr) { bsum += d; bn += 1.0; }
  }
  if (bn < 0.5) return 1.0;
  float dBlock = max(zr - bsum / bn, 0.0) * info.y;
  float fr = clamp((dBlock * uLightTan + 0.3) / info.x, 1.5 * info.z, sr);
  // (no 'all blockers found = full umbra' shortcut: with a few rotated samples it fires inside penumbrae and the
  //  dithered clear-plastic shadows, leaving isolated black pixels; the filter costs little there)
  // a small filter uses the same tap pattern for neighbouring pixels (no salt-and-pepper along contact lines)
  mat2 prot = fr < 2.0 * info.z ? mat2(0.8, 0.6, -0.6, 0.8) : rot;
  float lit = 0.0;
  int np = min(PCF_SAMPLES, max(uTaps, 3));
  for (int i = 0; i < PCF_SAMPLES; i++) {
    if (i >= np) break;
    float fi = float(i) + 0.5;
    vec2 o = prot * vec2(cos(fi * 2.39996), sin(fi * 2.39996)) * sqrt(fi / float(np)) * fr;
    lit += texture(smc, vec3(c.xy + o, zr));
  }
  // (the filter's two tails are cut: a penumbra pixel with one tap lit of sixteen, or one in shadow, is sampling noise, and on a
  //  bright satin part it glitters; the middle of the penumbra is as soft as it was)
  return smoothstep(0.1, 0.9, lit / float(np));
}
float sunShadow(vec3 wp, vec3 n, float extra, float rnd) {
  bool in0, in1;
  float NoL = dot(n, uSunDir);
  float s = pcss(uShadow0, uShadowCmp0, uShadowMat0, uShadowInfo0, wp, n, NoL, extra, rnd, in0);
  if (in0) return s;
  return pcss(uShadow1, uShadowCmp1, uShadowMat1, uShadowInfo1, wp, n, NoL, extra, rnd, in1);
}

// Glass marbles: soft analytic shadows with a gentle focused caustic, and contact occlusion
vec3 marbleShadow(vec3 p, vec3 n, out float ao, int skip) {
  vec3 T = vec3(1.0);
  ao = 1.0;
  int i1 = min(uMarbleRange.y, MARBLE_SHADOWS);
  for (int i = uMarbleRange.x; i < i1; i++) {
    if (i == skip) continue;
    vec4 m = uMarbles[i];
    vec3 d = m.xyz - p;
    float dist2 = dot(d, d);
    if (dist2 > 16000.0) continue;
    float dist = sqrt(dist2);
    float r = m.w;
    ao *= 1.0 - clamp(dot(n, d / dist), 0.0, 1.0) * clamp(r * r / dist2, 0.0, 1.0) * 0.95;
    float t = dot(d, uSunDir);
    if (t <= 0.0) continue;
    float h = length(d - uSunDir * t);
    float pen = r * 0.08 + t * uLightTan * 1.4;
    float occ = 1.0 - smoothstep(r - pen, r + pen, h);
    if (occ <= 0.0) continue;
    float focus = abs(t - 1.5 * r) / (1.5 * r);
    float rc = r * max(0.2, 0.1 + 0.5 * focus);
    float caustic = exp(-h * h / (rc * rc)) * min(0.5 * r * r / (rc * rc), 1.2) * 0.7;   // (0.7: a swirl blocks some light)
    vec3 tint = uMarbleCol[i].rgb;
    T *= mix(vec3(1.0), tint * (0.08 + caustic) + 0.04, occ * uMarbleCol[i].a);
  }
  return T;
}

// Scene colour encoding (float targets store linear HDR; 8-bit fallback stores a reversible curve)
vec4 encodeScene(vec3 c) {
#ifdef LDR_TARGET
  c = max(c, 0.0); return vec4(c / (1.0 + c), 1.0);
#else
  return vec4(c, 1.0);
#endif
}
vec3 decodeScene(vec3 c) {
#ifdef LDR_TARGET
  c = min(c, 0.996); return c / (1.0 - c);
#else
  return c;
#endif
}
`;

/* ---- Opaque physically based materials ---- */
// Pieces are drawn instanced: every piece that shares a mesh in one draw. Each instance has three texels in uInst
// (see frameInstances): x, y (3D), cos, sin of its turn about Z | z lift (picked up), scale, glow, stretch | glow colour.
// Row 0 is the room (no transform); a draw's instances start at uInstBase.
// Material flags (aMat.w): 0 plain, 1 engraved letters, 4 glue, 5 emissive (a ceiling light), 6 a one-sided room
// surface (the desk, the ceiling, the side walls: clipped away when the eye is behind its plane, so a camera that
// orbits out past the room never has an opaque floor or ceiling between it and the tower; the opaque pass draws both
// faces of everything else), 7 emissive and one-sided. The plane a one-sided surface is clipped by is its own normal,
// or, for something standing on a wall (a window frame), the wall's: aMat.z = 1 +x, 2 -x, 3 -y (a ceiling), 4 +y.
const VS_PBR = `
in vec3 aPos; in vec3 aNrm; in vec2 aUv; in vec4 aTan; in vec4 aCol; in vec4 aMat;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform highp sampler2D uInst;
uniform int uInstBase;
out vec3 vPos; out vec3 vNrm; out vec4 vTan; out vec2 vUv; out vec4 vCol; out vec4 vMat; out float vGlow; flat out vec3 vGlowCol;
ivec2 instTexel(int i, int k) { return ivec2((i & ${INST_PER_ROW - 1}) * 3 + k, i >> ${Math.log2(INST_PER_ROW)}); }
void main() {
  int i = uInstBase + gl_InstanceID;
  vec4 xf = texelFetch(uInst, instTexel(i, 0), 0), fx = texelFetch(uInst, instTexel(i, 1), 0);
  vec3 p = aPos * fx.y, n = aNrm, t = aTan.xyz;
  if (fx.w > 0.0) { p.x *= fx.w; n = normalize(vec3(n.x / fx.w, n.yz)); }   // (a piece being resized: stretched along its length)
  float c = xf.z, s = xf.w;
  p.xy = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + xf.xy;
  p.z += fx.x;
  n.xy = vec2(c * n.x - s * n.y, s * n.x + c * n.y);
  t.xy = vec2(c * t.x - s * t.y, s * t.x + c * t.y);
  vPos = p; vNrm = n; vTan = vec4(t, aTan.w); vUv = aUv; vCol = aCol; vMat = aMat;
  vGlow = fx.z; vGlowCol = texelFetch(uInst, instTexel(i, 2), 0).rgb;
  gl_Position = uViewProj * vec4(p, 1.0);
  if (aMat.w > 5.5) {                                          // one-sided: seen from behind its plane, clipped away
    vec3 cn = aMat.z < 0.5 ? n : aMat.z < 1.5 ? vec3(1.0, 0.0, 0.0) : aMat.z < 2.5 ? vec3(-1.0, 0.0, 0.0) : aMat.z < 3.5 ? vec3(0.0, -1.0, 0.0) : vec3(0.0, 1.0, 0.0);
    if (dot(uCamPos - p, cn) < 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
}`;

const FS_PBR = GLSL_COMMON + `
uniform sampler2D uAlb;
uniform sampler2D uSurf;
uniform float uLodBias;
uniform float uNormalScale;
uniform float uBoardRefl;  // per draw: 1 = mounted on the pegboard (reflections behind it see the board)
uniform vec3 uBoardCol;    // the pegboard's lit colour, as reflected
uniform float uEdgeAA;     // per draw, kept in the scene's alpha: 1 = geometry whose edges FXAA may smooth, 0 = a big textured surface
uniform float uPeg;        // per draw: 1 = the pegboard (its holes, rims and the view down them are worked out here, exactly, at any zoom)
uniform float uWall;       // per draw: 1 = the block wall (mortar joints worked out here)
uniform float uDetail;     // per draw: strength of the fine detail normal layer (the wall)
uniform sampler2D uContact;    // R8, board space: contact occlusion under every foot, plate and tube (see updateContact)
uniform vec4 uContactInfo;     // x, y: board offset of the map, z, w: 1 / (map size in board units)
uniform sampler2D uPegAlb;     // the pegboard's albedo: what the pieces mounted on it mirror
uniform sampler2D uPegHole;    // its hole pattern, one 20-unit cell, mipmapped (see pegSeen)
uniform sampler2D uDetailTex;  // a fine normal tile (the wall's detail layer)
uniform vec4 uBoardRect;       // the pegboard's edges in board units (y down): x0, y0, x1, y1
#ifdef DEBUG
uniform int uDebug;
#endif
in vec3 vPos; in vec3 vNrm; in vec4 vTan; in vec2 vUv; in vec4 vCol; in vec4 vMat; in float vGlow; flat in vec3 vGlowCol;
out vec4 outColor;
// The pegboard: a hole every 20 board units (the snap grid), 3.7 units in radius, right through a 9-unit board
const float HOLE_R = 3.7, HOLE_PITCH = 20.0, BOARD_THICK = 9.0;
// The pegboard as a pieces' reflection sees it at board point b (y down): the hole pattern, from a one-cell mipmapped,
// anisotropic tile (genPegHoleTile: hole, bevel and board, the hole in the middle). A reflection squeezed by a curved piece
// is averaged by the hardware along the long side of the pixel's footprint (bdx, bdy on the board), so the holes keep their
// pitch along a rod and smear across it, and the pattern is its mean PEG_MEAN when the footprint spans several pitches. A
// rough piece blurs it by aa units more.
const float PEG_MEAN = 0.87;
float pegSeen(vec2 b, vec2 bdx, vec2 bdy, float aa) {
  float g = aa / HOLE_PITCH;
  return textureGrad(uPegHole, (b + 10.0) / HOLE_PITCH, bdx / HOLE_PITCH + vec2(g, 0.0), bdy / HOLE_PITCH + vec2(0.0, g)).r;
}
void main() {
  float flag = vMat.w;
  if ((flag > 4.5 && flag < 5.5) || flag > 6.5) {            // emissive (the ceiling's light strips): its own light, no shading
    outColor = encodeScene(vCol.rgb * 5.5); outColor.a = uEdgeAA; return;
  }
  vec4 alb = texture(uAlb, vUv, uLodBias);
  vec4 surf = texture(uSurf, vUv, uLodBias);
  vec3 albedo; float ao, engr = 1.0;
  if (flag > 0.5 && flag < 1.5) {
    // engraved letters only where they are big enough to read (about 9 px tall on screen); smaller, a plain face
    // (their colour and their engraving both fade out)
    vec2 fw = fwidth(vUv);
    float letterPx = 0.125 / max(max(fw.x, fw.y), 1e-6) * 0.7;
    engr = smoothstep(8.5, 12.0, letterPx);
    albedo = mix(vCol.rgb, alb.rgb, alb.a * engr); ao = vCol.a;
  }
  else { albedo = alb.rgb * vCol.rgb; ao = alb.a * vCol.a; }
  vec3 N0 = normalize(vNrm);
  if (!gl_FrontFacing) N0 = -N0;
  // the block wall (uWall): mortar joints between 500 x 250 blocks (11 units wide, odd courses shifted by half a block),
  // worked out from the position so they stay crisp at any zoom, and a fine detail normal layer; far away, where a
  // pixel is wider than a joint, they average out to their mean coverage. Mortar is a shade darker and rougher, with a
  // little occlusion along its edges and a tilt of the block's edge into the joint. Mortar lines run on across the
  // corner into the side walls (the courses depend on the height alone).
  float wallM = 0.0;
  vec3 wallTilt = vec3(0.0);
  vec2 detUv = vec2(0.0);
  if (uWall > 0.5) {
    vec3 an = abs(N0);
    float tb = -vPos.y;                                             // board y (down), as the wall texture's rows run
    float sc = an.z > 0.5 ? vPos.x : vPos.z + 1850.0 * sign(N0.x);   // (the side walls' texture is shifted 0.37 of a tile: keep the joints on the blocks it paints)
    detUv = an.y > 0.5 ? vec2(vPos.x, vPos.z) : vec2(sc, tb);
    vec2 fw = fwidth(vec2(sc, tb));                                 // (derivatives outside the branch below: it is not uniform across a quad)
    if (an.y < 0.5) {                                               // (the plaster ceiling has no joints)
      float row = floor(tb / 250.0);
      float sx = mod(sc - mod(row, 2.0) * 250.0 + 255.5, 500.0) - 250.0, sy = mod(tb + 130.5, 250.0) - 125.0;
      float ax = abs(sx), ay = abs(sy);
      float far = smoothstep(6.0, 22.0, max(fw.x, fw.y));
      wallM = max(1.0 - smoothstep(5.5 - 0.5 * fw.x, 5.5 + 0.5 * fw.x, ax), 1.0 - smoothstep(5.5 - 0.5 * fw.y, 5.5 + 0.5 * fw.y, ay));
      wallM = mix(wallM, 0.07, far);
      float edgeO = max(1.0 - smoothstep(5.5, 11.5, ax), 1.0 - smoothstep(5.5, 11.5, ay));
      albedo = mix(albedo, albedo * 0.8, wallM);
      ao *= 1.0 - 0.12 * mix(edgeO, 0.1, far);
      float kx = smoothstep(5.0, 5.7, ax) * (1.0 - smoothstep(5.7, 8.5, ax)), ky = smoothstep(5.0, 5.7, ay) * (1.0 - smoothstep(5.7, 8.5, ay));
      vec2 tl = vec2(-sign(sx) * kx, sign(sy) * ky) * 0.7 * (1.0 - far);
      wallTilt = an.z > 0.5 ? vec3(tl.x, tl.y, 0.0) : vec3(0.0, tl.y, tl.x);
    }
  }
  // the pegboard (uPeg): holes drawn analytically (a distance to the nearest hole centre, exactly anti-aliased at any
  // zoom), a darker bevel and occlusion ring round each, and the view down each bore traced below
  vec2 pb = vec2(vPos.x, -vPos.y), pq = vec2(0.0);
  float pd = 99.0, pegIn = 0.0, contact = 1.0;
  if (uPeg > 0.5) {
    contact = texture(uContact, (pb + uContactInfo.xy) * uContactInfo.zw).r;
    pq = (fract((pb + 10.0) / HOLE_PITCH) - 0.5) * HOLE_PITCH;
    pd = length(pq);
    vec2 pu = pq / max(pd, 1e-4);
    float paa = max(0.5 * (abs(dot(pu, dFdx(pb))) + abs(dot(pu, dFdy(pb)))), 0.02);
    pegIn = 1.0 - smoothstep(HOLE_R - paa, HOLE_R + paa, pd);
    albedo *= 1.0 - 0.18 * (1.0 - smoothstep(HOLE_R, HOLE_R + 1.3, pd));
  }
  vec3 T = vTan.xyz - N0 * dot(N0, vTan.xyz);
  T = dot(T, T) > 1e-8 ? normalize(T) : vec3(1.0, 0.0, 0.0);
  vec3 B = cross(N0, T) * vTan.w;
  vec2 nxy = (surf.xy * 2.0 - 1.0) * uNormalScale * engr;
  nxy *= 1.0 - 0.8 * (1.0 - smoothstep(0.06, 0.2, clamp(surf.z * vMat.x, 0.04, 1.0)));   // (polished chrome keeps only a trace of the brushed grain: against a bright and dark room its texel noise would glitter)
  if (uDetail > 0.0) nxy += (texture(uDetailTex, detUv / 24.0).xy * 2.0 - 1.0) * uDetail;
  vec3 N = normalize(T * nxy.x + B * nxy.y + N0 * sqrt(max(1.0 - dot(nxy, nxy), 0.05)) + wallTilt);
  float rough = clamp(surf.z * vMat.x, 0.04, 1.0), rough0 = rough;   // (rough0: the surface's own; rough also covers the curvature under a pixel)
  vec3 dn = fwidth(N0);
  rough = sqrt(rough * rough + min(dot(dn, dn) * 0.6, 0.2));
  rough = min(rough + 0.15 * wallM, 1.0);
  float metal = vMat.y;
  vec3 V = normalize(uCamPos - vPos);
  float NoV = clamp(dot(N, V), 1e-4, 1.0);
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffC = albedo * (1.0 - metal);
  float rnd = ign(gl_FragCoord.xy);
  // key light: sun through the window, soft shadows (board and marbles)
  vec3 L = uSunDir;
  float NoL = dot(N, L);
  float NoLg = dot(N0, L);
  float sh = NoLg > -0.05 ? sunShadow(vPos, N0, 0.0, rnd) * windowCookie(vPos, uSunDir) : 0.0;
  float mao;
  vec3 mT = marbleShadow(vPos, N0, mao, -1);
  vec3 direct = vec3(0.0);
  if (NoL > 0.0 && sh > 0.0) {
    vec3 H = normalize(L + V);
    float NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
    float a = rough * rough;
    vec3 F = F_Schlick(f0, VoH);
    vec3 spec = D_GGX(NoH, max(a, 0.002)) * V_Smith(NoV, NoL, max(a, 0.002)) * F;
    float wrap = flag > 3.5 && flag < 4.5 ? 0.3 : 0.0;            // glue: a hint of translucency
    vec3 diff = diffC / PI * (1.0 - F);
    direct = (diff * clamp((NoL + wrap) / (1.0 + wrap), 0.0, 1.0) + spec * NoL) * uSunCol * sh * mT;
    direct *= mix(1.0, contact, 0.6);                       // (next to a plate or foot the board also sees less of the sun's big disc: the contact map takes part of it too)
  }
  // ambient: SH irradiance + prefiltered environment, occluded by the baked AO and nearby marbles
  float occ = ao * mao;
  if (uPeg > 0.5) occ *= contact * (1.0 - 0.45 * (1.0 - smoothstep(HOLE_R, HOLE_R + 1.8, pd)) * (1.0 - pegIn));
  vec3 irr = shIrradiance(N);
  if (flag > 5.5) irr += vec3(0.62, 0.59, 0.54) + vec3(0.55, 0.45, 0.32) * max(-N.y, 0.0);   // the room's far surfaces (side walls, ceiling, desk): daylight bounced round the room, the sunlit desk's warm bounce up on the ceiling
  // (pieces on the board also catch the light bounced up from the sunlit desk and the board: the SH keeps the desk dim, and
  //  the undersides of matt and satin parts would go black)
  irr += uBoardRefl * vec3(0.62, 0.52, 0.4) * (0.3 + 0.7 * max(-N.y, 0.0));
  vec3 envB = envBRDF(f0, rough, NoV);
  vec3 R = reflect(-V, N);
  float horizon = clamp(1.0 + 1.3 * dot(R, N0), 0.0, 1.0);
  // (specular anti-aliasing: the angle one pixel's reflection sweeps, as the cube level whose edges are that soft: a thin rod
  //  turns its whole reflected room under a few pixels, and sharp lights and walls would alias into hairlines on it)
  float fpR = max(length(dFdx(R)), length(dFdy(R)));
  float envRough = max(rough, min(4.0 * sqrt(max(0.5 * fpR - 0.012, 0.0) / 0.8), uEnvMax) / uEnvMax);
  vec4 envC4 = envSpec4(R, envRough);
  vec3 envC = envC4.rgb;
  // A mirror (chrome, glass: rough < 0.06 .. 0.2) shows the room as it is, its bright lights and its dim walls (the cube's alpha:
  // envMirror); every other piece keeps the pale daylit room, lifted a little (and a soft bright ceiling: the room above the
  // board is brighter than the env model's).
  float mirror = 1.0 - smoothstep(0.06, 0.2, rough);
  envC = mix(envC, envMirror(envC4), mirror);
  envC = envC * (1.0 + 0.6 * uBoardRefl * (1.0 - mirror)) + uBoardRefl * (1.0 - mirror) * vec3(0.4, 0.39, 0.37) * smoothstep(-0.05, 0.8, R.y);
  // A piece mounted on the board mirrors the board behind it where its reflected ray goes into it: the real board, the point
  // bp where the ray meets the board's plane, with its grain, the hole pattern there, the sun patch on it and the foot plates'
  // contact shade; beyond the board's edge, the wall. The pattern is blurred by the piece's roughness over the distance the ray
  // travels and filtered over the pixel's footprint on the board (bdx, bdy), so it never aliases: it is its mean where the
  // reflection is stretched (grazing, the piece's silhouette).
  if (uBoardRefl > 0.5) {
    float tB = -vPos.z / min(R.z, -0.05);                              // distance along R to the board's plane
    vec2 bp = vec2(vPos.x, -vPos.y) + vec2(R.x, -R.y) * tB;
    vec2 bdx = dFdx(bp), bdy = dFdy(bp);                                // (derivatives out here: uBoardRefl is uniform per draw)
    float bw = mix(smoothstep(0.35, -0.25, R.z) * 0.5, smoothstep(0.3, -0.2, R.z) * 0.95, mirror);   // (a mirror sees the board wherever its reflected ray goes into it)
    if (bw > 0.002) {
      float edge = smoothstep(0.02, 0.2, dot(N0, V)) * smoothstep(0.0, -0.15, R.z);   // (no pattern at the piece's silhouette or a grazing reflection)
      float aa = 0.5 + tB * rough0 * 0.9;                               // (a rough surface blurs what is far behind it)
      float gw = max(exp2(rough0 * 5.0), 6.0);                           // (the grain's filter footprint, in units: the pixel's, widened by the roughness and by at least 6: the grain's texels, seen along a rod, would be beads)
      float pl = dot(textureGrad(uPegAlb, (bp + 10.0) / 320.0, (bdx + vec2(gw, 0.0)) / 320.0, (bdy + vec2(0.0, gw)) / 320.0).rgb, vec3(0.3, 0.59, 0.11)) / 0.23;
      float pat = mix(PEG_MEAN, pegSeen(bp, bdx, bdy, aa), edge);
      pat = clamp(PEG_MEAN + (pat - PEG_MEAN) * mix(1.0, 1.8, mirror), 0.04, 1.1);   // (a mirror's squeezed holes are drawn a little bolder than their true average, so a soft dash reads at 1:1)
      float lit = 0.5 + 0.55 * windowCookie(vec3(bp.x, -bp.y, 0.0), uSunDir);                      // the sun patch on the board there
      float cs = mix(1.0, texture(uContact, (bp + uContactInfo.xy) * uContactInfo.zw).r, 0.8);    // the plates' and feet's contact shade
      // (under an overhang what a face mirrors is brightened by the bounces between it and the plate and board below it)
      float bounce = 1.0 + 0.9 * (1.0 - mirror) * smoothstep(0.2, 0.8, -N0.y);
      vec3 bc = uBoardCol * mix(1.0, pl, 0.7 * edge) * pat * lit * cs * bounce;
      vec2 inB = smoothstep(uBoardRect.xy - 12.0, uBoardRect.xy + 12.0, bp) * (1.0 - smoothstep(uBoardRect.zw - 12.0, uBoardRect.zw + 12.0, bp));
      bc = mix(vec3(0.2, 0.19, 0.17), bc, inB.x * inB.y);
      envC = mix(envC, bc, bw);
    }
  }
  vec3 spec = envC * envB * horizon * horizon;
  float specOcc = clamp(pow(NoV + occ, exp2(-16.0 * rough - 1.0)) - 1.0 + occ, 0.0, 1.0);
  vec3 ambient = diffC * irr / PI * occ * (1.0 - envB * 0.5) + spec * specOcc;
  // a struck piece stays metal: a quick flash of its reflections (the first ~0.1 s), and a thin rim of light in its
  // note's colour where its surface turns away from the eye
  float flash = vGlow * vGlow * vGlow;
  vec3 col = direct * (1.0 + 0.8 * flash) + ambient + spec * specOcc * 1.6 * flash;
  col += vGlowCol * vGlow * (pow(1.0 - NoV, 2.0) * 0.9 + 0.06);
  // looking down a pegboard hole: the ray from the eye enters at this fragment and either meets the bore's wall (lit
  // by the sun where its ray out of the hole stays inside the bore, ambient dimmer the deeper it is) or leaves by the
  // open back, the gap's shade
  if (pegIn > 0.0) {
    vec2 m = vec2(-V.x, V.y) / max(abs(V.z), 0.05);                // board-space shift per unit of depth
    float c = min(dot(pq, pq) - HOLE_R * HOLE_R, 0.0), mm = dot(m, m), qm = dot(pq, m);
    float tHit = mm > 1e-6 ? (-qm + sqrt(max(qm * qm - mm * c, 0.0))) / mm : 1e5;
    vec3 holeC;
    if (tHit < BOARD_THICK) {
      vec2 h = pq + m * tHit;
      vec3 nw = vec3(-h.x, h.y, 0.0) / HOLE_R;                     // the wall's normal, towards the bore's axis
      float lit = 1.0 - smoothstep(HOLE_R - 0.6, HOLE_R + 0.6, length(h + vec2(L.x, -L.y) / max(L.z, 0.05) * tHit));
      vec3 wc = albedo * 0.62;
      float deep = 1.0 - 0.7 * tHit / BOARD_THICK;                // (the deeper the wall, the less light gets down there)
      holeC = wc / PI * (max(dot(nw, L), 0.0) * uSunCol * sh * lit * deep + (shIrradiance(nw) + vec3(0.5, 0.47, 0.42)) * deep * deep * 0.5);   // (+ the daylight bounced round the room, as on the room's far surfaces)
    } else holeC = (albedo * 0.5 + 0.05) * 0.2;                    // (the open back: the dim wall in the gap)
    col = mix(col, holeC, pegIn);
  }
#ifdef DEBUG
  if (uDebug == 1) col = vec3(sh);                          // inspection: key-light visibility only
  if (uDebug == 2) col = envC;                              // inspection: the reflected room
  if (uDebug == 3) col = vec3(specOcc, occ, horizon);      // inspection: reflection occlusion terms
  if (uDebug == 4) col = vec3(contact);                    // inspection: the board's contact-occlusion map
#endif
  outColor = encodeScene(col);
  outColor.a = uEdgeAA;
}`;

/* ---- Depth only (shadow maps) ---- */
const FS_DEPTH = `
uniform float uCoverage;   // < 1: clear plastic casts a partial, dithered shadow that PCF blurs into a soft one
out vec4 outColor;
void main() {
  if (uCoverage < 1.0) {
    float h = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));   // interleaved gradient noise
    if (h > uCoverage) discard;
  }
  outColor = vec4(1.0);
}`;

/* ---- Glass marbles (instanced spheres, ray-traced inside) ---- */
const VS_MARBLE = GLSL_WINDOW + `
in vec3 aPos;
in vec4 aIPos; in vec4 aIRot; in vec4 aIGlass; in vec4 aISwirl;
uniform mat4 uViewProj;
uniform sampler2D uShadow0;
uniform mat4 uShadowMat0;
uniform sampler2D uShadow1;
uniform mat4 uShadowMat1;
uniform vec3 uSunDir;
out vec3 vPos; flat out vec4 vC; flat out vec4 vRot; flat out vec4 vGlass; flat out vec4 vSwirl; flat out float vLit; flat out int vId;
float tap(sampler2D sm, mat4 m, vec3 p, out bool ok) {
  vec4 s = m * vec4(p, 1.0); vec3 c = s.xyz / s.w * 0.5 + 0.5;
  ok = c.x > 0.0 && c.x < 1.0 && c.y > 0.0 && c.y < 1.0;
  if (!ok) return 1.0;
  float lit = 0.0;
  for (int i = 0; i < 4; i++) { vec2 o = vec2(float(i & 1) - 0.5, float(i >> 1) - 0.5) * 0.0016; lit += step(c.z - 0.002, texture(sm, c.xy + o).r); }
  return lit * 0.25;
}
void main() {
  vec3 c = aIPos.xyz;
  vec3 p = c + aPos * aIPos.w * 1.04;
  vPos = p; vC = aIPos; vRot = aIRot; vGlass = aIGlass; vSwirl = aISwirl; vId = gl_InstanceID;
  bool ok;
  vec3 sp = c + uSunDir * aIPos.w * 0.9;
  float l = tap(uShadow0, uShadowMat0, sp, ok);
  if (!ok) l = tap(uShadow1, uShadowMat1, sp, ok);
  vLit = l * windowCookie(c, uSunDir);
  gl_Position = uViewProj * vec4(p, 1.0);
}`;

const FS_MARBLE = GLSL_COMMON + `
uniform sampler2D uScene;
in vec3 vPos; flat in vec4 vC; flat in vec4 vRot; flat in vec4 vGlass; flat in vec4 vSwirl; flat in float vLit; flat in int vId;
out vec4 outColor;
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
// Cat's-eye: thin, twisted, lens-shaped coloured vanes around the local y axis
// dsU: march step in unit-sphere units; a vane is never thinner than ~a step, so neighbouring pixels agree
float vanes(vec3 q, float seed, float dsU) {
  float r = length(q);
  if (r > 0.86) return 0.0;
  float rho = length(q.xz);
  float k = 3.0 + step(0.5, fract(seed * 7.0));                 // three or four vanes
  float ang = atan(q.z, q.x) - q.y * (0.9 + seed * 1.2) - seed * 6.2831;
  float w = 6.2831853 / k;
  float sector = mod(ang, w) - 0.5 * w;
  float dist = abs(sin(sector)) * rho;
  float thick = 0.012 + 0.05 * (1.0 - rho / 0.86) * (1.0 - 0.7 * q.y * q.y);
  float thickEff = max(thick, dsU);                              // (at least a step each side: no moiré)
  float d = smoothstep(thickEff, thickEff * 0.35, dist) * (thick / thickEff);   // same total opacity
  return d * smoothstep(0.86, 0.7, r) * step(0.0, cos(sector));
}
void main() {
  vec3 C = vC.xyz; float R = vC.w;
  vec3 rd = normalize(vPos - uCamPos);
  vec3 oc = uCamPos - C;
  float b = dot(oc, rd), cc = dot(oc, oc) - R * R, h = b * b - cc;
  if (h < 0.0) discard;
  float tHit = -b - sqrt(h);
  vec3 P = uCamPos + rd * tHit;
  vec4 clip = uViewProj * vec4(P, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  vec3 N = normalize(P - C), V = -rd;
  float NoV = max(dot(N, V), 0.0);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  float lit = vLit;
  float mao; vec3 mT = marbleShadow(C, vec3(0.0, 1.0, 0.0), mao, vId);
  vec3 sunC = uSunCol * lit * mT;
  // reflection: the room, darkened where the board is right behind the marble
  vec3 Rr = reflect(rd, N);
  vec3 refl = envSpec(Rr, 0.0);
  float board = smoothstep(0.05, -0.35, Rr.z);
  refl = mix(refl, vec3(0.32, 0.22, 0.13) * (0.4 + 0.6 * lit), board * 0.8);
  // refraction into the glass and a short march through the swirl
  vec3 Tr = refract(rd, N, 1.0 / 1.5);
  float L = max(-2.0 * dot(P - C, Tr), 0.0);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  vec4 qi = vec4(-vRot.xyz, vRot.w);
  // more steps for big close-up marbles; one jitter per marble (not per pixel) so the swirl has no dither
  float rpx = R / max(length(fwidth(vPos)), 1e-4);
  int steps = rpx > 60.0 ? 48 : rpx > 30.0 ? 32 : 22;
  float ds = L / float(steps), dsU = ds / R;
  float jit = fract(vSwirl.a * 7.1);
  vec3 swirlLit = vSwirl.rgb * (shIrradiance(N) * 0.32 + sunC * 0.16);
  for (int i = 0; i < 48; i++) {
    if (i >= steps) break;
    float s = (float(i) + jit) * ds;
    vec3 q = qrot(qi, (P + Tr * s - C) / R);
    float d = vanes(q, vSwirl.a, dsU);
    if (d > 0.001) {
      float a = 1.0 - exp(-d * ds / R * 9.0);
      float edge = 0.75 + 0.5 * smoothstep(0.3, 0.85, length(q));
      acc += trans * a * swirlLit * edge;
      trans *= 1.0 - a;
      if (trans < 0.02) break;
    }
  }
  // tiny air bubbles
  for (int i = 0; i < 3; i++) {
    vec3 bp = vec3(sin(vSwirl.a * 91.0 + float(i) * 2.1), cos(vSwirl.a * 37.0 + float(i) * 1.7), sin(vSwirl.a * 53.0 + float(i) * 3.3)) * 0.55;
    vec3 wp = C + qrot(vRot, bp) * R;
    float t = dot(wp - P, Tr);
    float dd = length(P + Tr * clamp(t, 0.0, L) - wp);
    acc += trans * smoothstep(0.045 * R, 0.0, dd) * 0.5 * (sunC + 0.2);
  }
  vec3 Pe = P + Tr * L;
  vec3 Ne = normalize(Pe - C);
  vec3 Tr2 = refract(Tr, -Ne, 1.5);
  if (dot(Tr2, Tr2) < 1e-4) Tr2 = reflect(Tr, -Ne);
  float tb = Tr2.z < -0.05 ? clamp(Pe.z / -Tr2.z, 2.0, 60.0) : 40.0;
  vec3 Pb = Pe + Tr2 * tb;
  vec4 bc = uViewProj * vec4(Pb, 1.0);
  vec2 suv = clamp(bc.xy / bc.w * 0.5 + 0.5, vec2(0.001), vec2(0.999));
  // the refracted image is minified: average a few taps across one pixel's footprint to avoid moire
  vec2 fw = max(fwidth(suv), vec2(0.5) / vec2(textureSize(uScene, 0)));
  vec3 bg = decodeScene(texture(uScene, suv).rgb) * 0.2;
  bg += decodeScene(texture(uScene, clamp(suv + fw * vec2(0.5, 0.5), 0.001, 0.999)).rgb) * 0.2;
  bg += decodeScene(texture(uScene, clamp(suv + fw * vec2(-0.5, 0.5), 0.001, 0.999)).rgb) * 0.2;
  bg += decodeScene(texture(uScene, clamp(suv + fw * vec2(0.5, -0.5), 0.001, 0.999)).rgb) * 0.2;
  bg += decodeScene(texture(uScene, clamp(suv + fw * vec2(-0.5, -0.5), 0.001, 0.999)).rgb) * 0.2;
  vec3 absorb = pow(max(vGlass.rgb, vec3(0.02)), vec3(L / (2.0 * R) * 1.25));
  // the sun focused through the ball glows on its far side
  float back = pow(max(dot(-Ne, -uSunDir) * 0.5 + 0.5, 0.0), 24.0);
  vec3 inner = bg * absorb * trans + acc + vGlass.rgb * sunC * back * 0.9 * trans;
  vec3 H = normalize(uSunDir + V);
  float NoL = max(dot(N, uSunDir), 0.0);
  vec3 glint = D_GGX(max(dot(N, H), 0.0), 0.035) * V_Smith(NoV, NoL, 0.035) * F_Schlick(vec3(0.04), max(dot(V, H), 0.0)) * NoL * sunC;
  vec3 col = mix(inner, refl, F) + glint;
  col *= mix(0.55, 1.0, mao);
  outColor = encodeScene(col);
  outColor.a = vGlass.a;
}`;

/* ---- Clear PET plastic (funnels, cup): thin-walled, reflective, slightly tinted ---- */
const FS_PET = GLSL_COMMON + `
in vec3 vPos; in vec3 vNrm; in vec4 vTan; in vec2 vUv; in vec4 vCol; in vec4 vMat; in float vGlow;
out vec4 outColor;
void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCamPos - vPos);
  float NoV = clamp(dot(N, V), 1e-3, 1.0);
  float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 refl = envSpec(R, 0.06);
  float rnd = ign(gl_FragCoord.xy);
  float sh = sunShadow(vPos, N, 2.0, rnd) * windowCookie(vPos, uSunDir);   // (+2 texels: clear plastic also casts a faint shadow)
  float mao; vec3 mT = marbleShadow(vPos, N, mao, -1);
  vec3 L = uSunDir;
  float NoL = max(dot(N, L), 0.0);
  vec3 H = normalize(L + V);
  vec3 spec = D_GGX(max(dot(N, H), 0.0), 0.012) * V_Smith(NoV, NoL, 0.012) * F_Schlick(vec3(0.04), max(dot(V, H), 0.0)) * NoL * uSunCol * sh;
  float path = 1.0 / max(NoV, 0.1);
  float absorb = clamp(0.006 * path, 0.0, 0.25);             // thin PET barely absorbs; grazing walls look denser
  float flag = vMat.w;
  vec3 tint = vCol.rgb;
  vec3 irr = shIrradiance(N);
  // light scattered in the plastic: a faint milky body, stronger where the wall is seen edge-on
  vec3 scatter = (irr * 0.05 + uSunCol * sh * mT * 0.03) * tint * (absorb * 2.0 + 0.035);
  float graze = pow(1.0 - NoV, 3.0);
  float edge = graze * 0.2;                                   // refraction at grazing angles: a darker outline...
  float alpha = clamp(F * 0.9 + absorb + edge + 0.03, 0.0, 0.9);
  vec3 col = refl * F * 0.9 + spec + scatter;
  col += refl * graze * 0.22 * tint;                          // ...that also catches the room light, like real bottle plastic
  if (flag > 2.5) { alpha = max(alpha, 0.6); col += (irr * 0.22 + uSunCol * sh * 0.22 + refl * 0.25) * tint * 0.7; }   // the cut rim
  col += vGlow * vec3(1.0, 0.8, 0.45) * 0.5;
  alpha = max(alpha, vGlow * 0.3);
#ifdef LDR_TARGET
  outColor = vec4(col / (1.0 + col) * 1.0, alpha);
#else
  outColor = vec4(col, alpha);
#endif
}`;

/* ---- Post: bloom chain and the final grade ---- */
const VS_QUAD = `
out vec2 vUv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
const FS_DOWN = `
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uPrefilter;
in vec2 vUv; out vec4 outColor;
vec3 dec(vec3 c) {
#ifdef LDR_TARGET
  c = min(c, 0.996); return c / (1.0 - c);
#else
  return c;
#endif
}
void main() {
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  if (uPrefilter > 0.5) {
    c = dec(c);
    float br = max(c.r, max(c.g, c.b));
    float knee = 0.6, thr = 1.4;
    float soft = clamp(br - thr + knee, 0.0, 2.0 * knee); soft = soft * soft / (4.0 * knee + 1e-4);
    c *= max(soft, br - thr) / max(br, 1e-4);
    c = min(c, vec3(40.0));
  }
  outColor = vec4(c, 1.0);
}`;
const FS_UP = `
uniform sampler2D uSrc; uniform vec2 uTexel;
in vec2 vUv; out vec4 outColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(uTexel.x, 0.0)).rgb + texture(uSrc, vUv - vec2(uTexel.x, 0.0)).rgb + texture(uSrc, vUv + vec2(0.0, uTexel.y)).rgb + texture(uSrc, vUv - vec2(0.0, uTexel.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + uTexel).rgb + texture(uSrc, vUv - uTexel).rgb + texture(uSrc, vUv + vec2(uTexel.x, -uTexel.y)).rgb + texture(uSrc, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
  outColor = vec4(c / 16.0, 1.0);
}`;
const FS_FINAL = `
uniform sampler2D uSrc; uniform sampler2D uBloom; uniform float uBloomAmt; uniform float uExposure; uniform float uTime; uniform vec2 uRes;
uniform int uFxaa; uniform vec2 uSrcTexel;
in vec2 vUv; out vec4 outColor;
vec3 dec(vec3 c) {
#ifdef LDR_TARGET
  c = min(c, 0.996); return c / (1.0 - c);
#else
  return c;
#endif
}
// ACES filmic (Stephen Hill's fit of the RRT + ODT)
vec3 aces(vec3 v) {
  const mat3 i = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 o = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  v = i * v;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(o * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec3 graded(vec2 uv) {
  vec3 c = dec(texture(uSrc, uv).rgb) + texture(uBloom, uv).rgb * uBloomAmt;
  return toSRGB(aces(c * uExposure));
}
// FXAA (used when the scene is not multisampled)
vec3 fxaa(vec2 uv, vec2 px) {
  const vec3 L = vec3(0.299, 0.587, 0.114);
  vec3 nw = graded(uv + vec2(-1.0, -1.0) * px), ne = graded(uv + vec2(1.0, -1.0) * px);
  vec3 sw = graded(uv + vec2(-1.0, 1.0) * px), se = graded(uv + vec2(1.0, 1.0) * px), m = graded(uv);
  float lNW = dot(nw, L), lNE = dot(ne, L), lSW = dot(sw, L), lSE = dot(se, L), lM = dot(m, L);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE))), lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  if (lMax - lMin < max(0.04, lMax * 0.12)) return m;
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), vec2(-8.0), vec2(8.0)) * px;
  vec3 a = 0.5 * (graded(uv + dir * (1.0 / 3.0 - 0.5)) + graded(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 b = a * 0.5 + 0.25 * (graded(uv - dir * 0.5) + graded(uv + dir * 0.5));
  float lB = dot(b, L);
  return (lB < lMin || lB > lMax) ? a : b;
}
// FXAA only where there is geometry. The scene's alpha marks it (pieces, frame, marbles): a pixel with no geometry
// in its 3x3 is the inside of a big textured surface (pegboard, wall, desk) whose texture is already filtered, so it
// is left exactly as MSAA would leave it, and the pegboard's round holes stay round instead of turning into crosses.
float geoAt(vec2 uv) { return texture(uSrc, uv).a; }
vec3 gatedFxaa(vec2 uv, vec2 px) {
  float geo = max(max(max(geoAt(uv), geoAt(uv + vec2(px.x, 0.0))), max(geoAt(uv - vec2(px.x, 0.0)), geoAt(uv + vec2(0.0, px.y)))),
                  max(max(geoAt(uv - vec2(0.0, px.y)), geoAt(uv + px)), max(geoAt(uv - px), max(geoAt(uv + vec2(px.x, -px.y)), geoAt(uv + vec2(-px.x, px.y))))));
  return geo < 0.05 ? graded(uv) : fxaa(uv, px);
}
void main() {
  vec3 c = uFxaa == 1 ? gatedFxaa(vUv, uSrcTexel) : graded(vUv);
  c = clamp((c - 0.5) * 1.04 + 0.5, 0.0, 1.0);               // a neutral grade: a little contrast, no extra saturation
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.5;                               // lens vignette
  float g = ign(gl_FragCoord.xy + 5.588238 * mod(floor(uTime * 60.0), 64.0));
  c += (g - 0.5) * 0.016;                                    // film grain / dither
  outColor = vec4(c, 1.0);
}`;
