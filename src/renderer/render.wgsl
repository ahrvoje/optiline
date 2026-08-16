// Optiline track-view render shader (§15.1, §15.2, §5.2).
//
// One affine world-to-screen transform in CSS pixels; the world +y-up
// to screen +y-down flip happens here and only here. Device pixel
// ratio never appears in this shader: the canvas backing store is
// sized cssSize * dpr by the host, so clip-space output is DPR-free.
//
// Vertex layout (24 bytes):
//   location 0 : world position, vec2<f32> (meters)
//   location 1 : world unit extrusion normal, vec2<f32> (zero for fills)
//   location 2 : misc = (arc distance along line in meters, side -1/0/+1)
//
// Thick lines are CPU-tessellated polylines extruded here by
// halfWidthPx / pxPerMeter along the per-vertex normal, so stroke width
// is constant in CSS pixels at every zoom. Dashed lines discard
// fragments by arc distance converted to CSS pixels.

struct DrawUniforms {
  // camera: centerX, centerY (world m), pxPerMeter (CSS px), unused
  camera : vec4<f32>,
  // viewport: width, height (CSS px), halfWidthPx, unused
  viewport : vec4<f32>,
  // straight-alpha RGBA
  color : vec4<f32>,
  // dashLenPx, gapLenPx, unused, unused (dashLenPx <= 0 means solid)
  dash : vec4<f32>,
};

@group(0) @binding(0) var<uniform> u : DrawUniforms;

struct VsIn {
  @location(0) pos : vec2<f32>,
  @location(1) normal : vec2<f32>,
  @location(2) misc : vec2<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) dist_m : f32,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  let px_per_m = u.camera.z;
  let half_width_px = u.viewport.z;
  // Constant-CSS-pixel extrusion expressed in world meters.
  let world = in.pos + in.normal * (in.misc.y * half_width_px / px_per_m);
  // World -> CSS screen (the only y flip, §5.2).
  let sx = (world.x - u.camera.x) * px_per_m + u.viewport.x * 0.5;
  let sy = (u.camera.y - world.y) * px_per_m + u.viewport.y * 0.5;
  // CSS screen -> clip.
  var out : VsOut;
  out.clip = vec4<f32>(
    sx / u.viewport.x * 2.0 - 1.0,
    1.0 - sy / u.viewport.y * 2.0,
    0.0,
    1.0,
  );
  out.dist_m = in.misc.x;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let dash_len = u.dash.x;
  if (dash_len > 0.0) {
    let period = dash_len + u.dash.y;
    let d_px = in.dist_m * u.camera.z;
    let m = d_px - floor(d_px / period) * period;
    if (m > dash_len) {
      discard;
    }
  }
  return u.color;
}
