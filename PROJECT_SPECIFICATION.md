# Optiline Project Specification

**Document status:** Normative implementation specification  
**Version:** 1.1-draft  
**Date:** 2026-08-16  
**Target:** Static web application on Windows 11 and current stable Google Chrome  
**Primary hardware:** NVIDIA RTX 4080 through WebGPU  

## 1. Normative language and completion rule

The words **SHALL**, **MUST**, **SHALL NOT**, and **MUST NOT** state requirements. **SHOULD** states a requirement that may be changed only by a recorded architecture decision. **MAY** states an option.

This document fixes the mathematical model, numerical procedures, data formats, GPU work decomposition, application states, and acceptance criteria for version 1. An implementation is incomplete if it introduces a geometric or dynamic formula that is not defined here, or if it replaces a certified operation with sampling without an explicit rule in this document.

The local repository `C:\repos\ph-splines` is the independent mathematical oracle. Its Python language and API are not production constraints. The production implementation SHALL port the required mathematics to C99 and WGSL. TypeScript SHALL call the C99 WebAssembly interface but SHALL NOT contain an independent authoritative copy of the mathematics. Both production ports SHALL be compared against checked-in oracle fixtures generated from the local repository.

## 2. Product goal

Optiline finds a closed, periodic racing line and its fastest feasible periodic driving profile for a selected two-dimensional track and a simplified vehicle model. The sole optimization score is certified lap time.

The application SHALL:

1. display a catalog of fictional, caricature Grand Prix-style tracks;
2. model each track from a closed PH centerline and constant-distance left and right boundaries;
3. model every candidate racing line as a closed quintic PH B-spline;
4. keep the complete swept surface of a finite tangent-aligned vehicle rectangle inside the legal lane for the whole lap;
5. compute a periodic speed profile subject to speed, combined tire-force, acceleration, braking, aerodynamic drag, and downforce constraints;
6. search many local PH mutations in parallel with WebGPU;
7. certify every published incumbent in binary64 C99/WebAssembly;
8. plot speed, acceleration, curvature-related stability utilization, and time;
9. save profiles locally; and
10. play the current and selected saved profiles together as a looping ghost race.

## 3. Explicit scope boundaries

Version 1 is planar. It SHALL NOT model elevation, banking, camber, suspension, gears, engine maps, energy use, thermal state, tire temperature, tire wear, load transfer, yaw dynamics, traffic interaction, collision response between race vehicles, or weather.

The vehicle dynamics are a force-limited point-mass model located at the geometric center of a finite rectangle. The rectangle affects geometric containment. It does not add yaw inertia or front/rear axle dynamics.

Saved vehicles in PLAY mode are ghosts. They may overlap. All start together, but they do not affect one another.

No numeric candidate-throughput target is normative. Performance SHALL be measured and optimized after correctness. Rendering, shader compilation, and binary64 incumbent certification SHALL be reported separately from raw GPU candidate evaluation.

## 4. Success criteria

The product is accepted only when all of these conditions hold:

1. A published profile has a closed, simple, regular, periodic, orientation-preserving PH racing line.
2. The effective vehicle rectangle is continuously certified inside the track for every path parameter.
3. The speed profile is periodic and continuously feasible under the specified piecewise-constant-acceleration model.
4. The displayed lap time equals the certified profile time within 1 microsecond.
5. OPTIMIZE, STOP, PLAY, SAVE, Zoomed, and racer focus follow the state rules in this document.
6. Selected saved profiles and the current unsaved profile start together and loop independently at their certified lap periods.
7. A release build runs from static assets in stable Chrome on Windows 11 with WebGPU.
8. The C99/WGSL PH kernels pass the cross-language oracle tests.

## 5. Units, coordinates, and notation

### 5.1 Units

Internal calculations SHALL use SI units:

| Quantity | Symbol | Unit |
|---|---:|---:|
| position and distance | \(x,y,s\) | m |
| time | \(t\) | s |
| speed | \(v\) | m/s |
| squared speed | \(q=v^2\) | m\(^2\)/s\(^2\) |
| acceleration | \(a\) | m/s\(^2\) |
| curvature | \(\kappa\) | 1/m |
| force | \(F\) | N |
| mass | \(m_v\) | kg |
| air density | \(\rho\) | kg/m\(^3\) |

The UI MAY display speed in km/h. Conversion is exactly

\[
v_{\mathrm{km/h}}=3.6v_{\mathrm{m/s}}.
\]

### 5.2 World frame

The world is a right-handed two-dimensional frame embedded in the screen plane:

- \(+x\) points right;
- \(+y\) points up in world coordinates;
- screen conversion flips \(y\);
- a positive signed area means counterclockwise traversal;
- the left unit normal is a positive 90-degree rotation of the tangent.

The renderer SHALL use one affine world-to-screen matrix. Geometry calculations SHALL never use screen coordinates.

### 5.3 Complex representation

Represent a point or vector by

\[
z=x+iy.
\]

For complex values \(a,b\), define

\[
\operatorname{dot}(a,b)=\operatorname{Re}(\overline a b),
\qquad
\operatorname{cross}(a,b)=\operatorname{Im}(\overline a b).
\]

Multiplication by \(i\) rotates a vector left by 90 degrees.

### 5.4 Periodic indexing

For a periodic array of length \(n\),

\[
\operatorname{wrap}(j,n)=((j\bmod n)+n)\bmod n.
\]

The preimage is antiperiodic. Its extended controls obey

\[
c_{j+kn}=(-1)^k c_j.
\]

Code SHALL implement the sign before applying the wrapped base index. A plain modulo is incorrect.

## 6. System architecture

### 6.1 Production stack

The repository SHALL use:

- native HTML and semantic elements;
- native CSS with CSS custom properties and container/media queries;
- TypeScript without a UI framework;
- Vite 8.2.x for the static build;
- TypeScript 7.0.x;
- ISO C99 as the source language for all authoritative CPU mathematics;
- Visual Studio 2022 Community 17.14 with the MSVC v143 x64 C compiler for native builds and tests;
- CMake 3.31 or later for native and WebAssembly build generation;
- WASI SDK 33.0 for x86-64 Windows, repository-pinned, with Clang/LLD 22.1.0 for compiling the same C99 sources to browser WebAssembly;
- WGSL compute and render shaders through the browser WebGPU API;
- IndexedDB for profiles and imported tracks; and
- Web Workers for optimizer control and binary64 certification.

Patch updates MAY be taken after tests pass. Major dependency updates require an architecture decision and full conformance run. The required local WASI SDK path is `C:\repos\optiline\tools\wasi-sdk-33.0-x86_64-windows`. The pinned Windows x86-64 WASI SDK archive SHA-256 is `df14ca2a2127c2d6b6be07e6f5549b3af9c1b3c0112430c200a4749970c59f06`. Emscripten is not required.

MSVC cannot emit browser WebAssembly and has no `/std:c99` mode. Therefore these two builds are mandatory:

1. **Native reference build:** compile every `.c` file as C with MSVC `/TC /std:c17`. The source SHALL remain within the ISO C99 language and library subset defined below. C17 mode is used only because it is the conforming C mode supplied by MSVC.
2. **Browser build:** compile the same source files with WASI SDK Clang using `--target=wasm32-wasip1 -mexec-model=reactor -std=c99`. WASI SDK/Clang is a build tool, not a second implementation language.

The portable source subset SHALL NOT use variable-length arrays, `<complex.h>`, C threads, C atomics, compiler vector extensions, implementation-defined bit-field layout, or type-punning through incompatible pointers. These restrictions match MSVC's documented missing optional facilities. Complex numbers SHALL use the explicit plain-old-data type

```c
typedef struct op_c64 { double re; double im; } op_c64;
typedef struct op_c32 { float  re; float  im; } op_c32;
```

with named `static` functions for add, subtract, multiply, conjugate, dot, cross, and scale. Fixed compile-time maximum sizes SHALL replace variable-length arrays. Bit reinterpretation SHALL use `memcpy`. The mathematical core SHALL not allocate memory after initialization; callers provide all work buffers.

The native release flags SHALL include `/O2 /TC /std:c17 /fp:strict /W4 /WX`. The WebAssembly certifier flags SHALL include `--target=wasm32-wasip1 -mexec-model=reactor -O3 -std=c99 -fno-fast-math -ffp-contract=off -Wall -Wextra -Werror`. The CMake configuration SHALL run both compilers in continuous integration. No build may define fast-math for authoritative binary64 certification. A separate f32 conformance target MAY enable contraction only when it matches the WGSL operation sequence tested in Section 24.4.

### 6.2 Process layout

The application has four execution contexts:

1. **Main thread:** DOM, controls, chart canvas, WebGPU rendering, animation clock, IndexedDB coordination.
2. **Optimizer worker:** WebGPU adapter/device, WGSL compute pipelines, population state, candidate batches, and periodic discovery snapshots.
3. **Live-presentation worker:** lazily created after the first complete 30-second interval; binary64 discovery conversion, canonical-curvature smoothing, closure projection, nested-mesh evaluation, and independent certification.
4. **Certifier worker:** C99/WASM binary64 PH compilation, containment certification, high-resolution dynamics, serialization validation, and CPU fallback optimizer.

GPU objects are not shared between contexts. The optimizer worker SHALL send only compact certified or display candidate data to the main thread at no more than 15 updates/s. Candidate lines SHALL be sent as transferable typed arrays.

### 6.3 Static deployment

The build output SHALL contain only static HTML, CSS, JavaScript, WGSL, WASM, JSON, images, and generated binary track assets. There is no application server and no remote account.

The host SHALL set:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Type: application/wasm       # for .wasm
Cache-Control: no-cache              # for index.html
Cache-Control: public,max-age=31536000,immutable  # hashed assets
```

These headers allow `SharedArrayBuffer` for low-latency STOP and shared diagnostics. Each WASIp1 reactor remains single-threaded and owns private memory. If cross-origin isolation is absent, the application SHALL use message-based STOP, one certifier worker, and show `CPU fallback: single worker`.

### 6.4 Required repository layout

```text
optiline/
  PROJECT_SPECIFICATION.md
  package.json
  package-lock.json
  vite.config.ts
  CMakeLists.txt
  index.html
  src/
    app/
    model/
    persistence/
    renderer/
    optimizer/
    charts/
    workers/
    shaders/
  cmake/
    wasi-sdk-version.txt    # exact SDK version, LLVM commit, and archive SHA-256
  tools/
    bootstrap-wasi.ps1      # verify/reuse or download the pinned SDK
  c/
    include/optiline/       # public C99 ABI and mathematical types
    src/                    # shared binary64 and f32 mathematical core
    wasm/                   # thin WASIp1 reactor export layer
    tools/                  # native track compiler and fixture tools
    tests/                  # native MSVC unit/property tests
  tracks/
    source/
    compiled/
  schemas/
  fixtures/
    ph-oracle/
    dynamics/
    containment/
  tests/
```

`tools/bootstrap-wasi.ps1` SHALL use only `C:\repos\optiline\tools\wasi-sdk-33.0-x86_64-windows`. It SHALL execute `clang --version` and read `VERSION`; both must match Section 6.1. If the SDK is absent, it MAY download the official pinned archive only after verifying its SHA-256. It SHALL never select an unpinned `latest` toolchain.

The files in `c/src` SHALL compile without source changes with MSVC and WASI SDK Clang. All authoritative binary64 mathematics belongs there, not in TypeScript or the WASI ABI layer. Public functions SHALL return a stable `op_result` error code and write results through caller-owned output pointers. They SHALL never throw, call JavaScript, retain a pointer into a temporary JavaScript view, or return ownership of allocated memory.

The browser build SHALL produce two WASIp1 reactors from the shared sources:

1. `optiline_certifier.wasm`, which exports version, workspace initialization, track compilation, validation, candidate certification, profile construction, and error-detail functions; and
2. `optiline_playback.wasm`, which exports analytic evaluation and the Section 8.8 distance-to-parameter query but no certification or optimizer function.

The loader SHALL instantiate each reactor with the `wasi_snapshot_preview1` import namespace and then call `_initialize`. Only deterministic stubs required by the linked module are permitted. A missing import SHALL trap with its name; it SHALL NOT silently return success. The production modules SHALL not access files, clocks, randomness, environment variables, processes, or networks. TypeScript SHALL validate byte lengths before every call and recreate typed-array views after any permitted WASM memory growth. Production SHALL set a fixed maximum memory and SHALL NOT grow memory during optimization or playback.

## 7. Authoritative track model

### 7.1 Source model

A source track contains:

- a unique stable identifier;
- an invented display name;
- an ordered cyclic list of exactly 64 centerline interpolation gates \(C_i\);
- a traversal direction;
- a constant left width \(d_L>0\);
- a constant right width \(d_R>0\);
- start gate index 0;
- display metadata; and
- source version and SHA-256 fingerprint.

The final source point SHALL NOT repeat the first point. Closure is implicit.

### 7.2 Centerline

The centerline SHALL be a closed quintic PH B-spline constructed by Section 8. It SHALL interpolate every \(C_i\), be regular, be simple, and have a continuous tangent and signed curvature at every join and at the seam.

### 7.3 Exact boundaries

For centerline \(r_c(u)\) with left normal \(N_c(u)\), define

\[
r_L(u)=r_c(u)+d_LN_c(u),
\qquad
r_R(u)=r_c(u)-d_RN_c(u).
\]

The track compiler SHALL reject a track unless both offsets are cusp-free:

\[
1-d_L\kappa_c(u)>0,
\qquad
1+d_R\kappa_c(u)>0
\quad\text{for all }u.
\]

Equivalently, if \((\rho_L,\rho_R)\) are the exact one-sided minimum curvature radii,

\[
d_L<\rho_L,
\qquad d_R<\rho_R.
\]

Both exact rational offset curves SHALL be simple and disjoint. Their orientation SHALL agree with the centerline. The left and right offsets plus the start cross-section define one annular lane.

### 7.4 Legal lane and certified corridor cells

The exact lane is the closed region between \(r_L\) and \(r_R\). For fast continuous containment, the track compiler SHALL also produce overlapping convex corridor cells. Every cell SHALL be proven to be a subset of the exact lane. The union SHOULD cover the exact lane to within 1 mm Hausdorff distance, except within 1 mm of the start cross-section where periodic overlap applies.

Each cell SHALL:

- be a counterclockwise convex polygon;
- have 3 to 8 half-spaces;
- be stored as normalized inequalities \(n_j\cdot x\le b_j\) with \(\|n_j\|=1\);
- carry a periodic gate interval and candidate neighbor list; and
- overlap its predecessor and successor enough to contain the default vehicle on the centerline.

Cell generation SHALL use an inward seed clearance

\[
\epsilon_{\mathrm{cell}}=0.00025\ \mathrm m.
\]

Evaluate the exact PH offsets at signed distances \(d_L-\epsilon_{\mathrm{cell}}\) and \(-d_R+\epsilon_{\mathrm{cell}}\). These two inner seed curves leave only a 0.25 mm strip unused at each exact boundary. Cell generation SHALL use adaptive tessellation of these seed curves, constrained triangulation of the inner lane ring, convex merging, and exact subset validation against the original boundaries:

1. Subdivide rational inner-seed spans until their homogeneous Bézier hull flatness is at most 0.25 mm.
2. Form a simple ring polygon from the two ordered boundary polylines.
3. Triangulate the ring without adding vertices outside it.
4. Merge adjacent triangles when their union is convex, has at most eight edges, and passes the subset test.
5. Add sliding overlapping merges around each gate interval.
6. Reject a cell if any polygon edge intersects an exact track boundary.
7. Classify one interior point by winding number and require it to be inside the exact lane.
8. Test one stored point from each complete boundary component; a cell SHALL NOT contain an entire boundary component.

For a cell edge \(a+\lambda e\) and rational boundary span

\[
B(u)=\frac{X(u)+iY(u)}{W(u)},\qquad W(u)>0,
\]

an intersection can occur only at a root of

\[
f(u)=\operatorname{cross}\left(e, X(u)+iY(u)-aW(u)\right)=0.
\]

The compiler SHALL isolate all roots of this Bernstein polynomial by recursive de Casteljau subdivision. A box with coefficient interval wholly above or below zero has no root. Ambiguous boxes SHALL be subdivided until their parameter width is at most \(2^{-48}\), then resolved with interval Newton. At every isolated root interval, compute the interval

\[
\lambda(u)=\frac{\operatorname{dot}(B(u)-a,e)}{\|e\|^2}.
\]

The edge and boundary intersect if the resulting interval overlaps \([0,1]\). Tangencies count as intersections. Track vertices shared by intended adjacent cells are not track-boundary exceptions; cells are tested against the exact outer lane boundaries, not against other cells.

### 7.5 Track normalization

Let the source bounding box center be \(O\) and

\[
H=\max(x_{\max}-x_{\min},y_{\max}-y_{\min}).
\]

All GPU geometry SHALL use

\[
\widehat z=(z-O)/H.
\]

Lengths scale by \(H\), and curvature scales by \(1/H\). C99 binary64 certification SHALL retain physical coordinates and the normalization pair. \(H\) must be finite and positive.

## 8. Quintic PH B-spline mathematical kernel

### 8.1 Required curve class

Version 1 SHALL use a quadratic complex preimage and quintic PH curve. A regular cubic PH curve has constant curvature sign on each nonstraight segment, so it cannot form a globally \(G^2\) racing loop with both left and right turns. Cubic PH is therefore not a production racing-line representation.

The preimage is

\[
w(t)=\sum_j c_jN_{j,2}(t),
\]

and the curve is defined by

\[
z'(t)=w(t)^2.
\]

Consequently,

\[
\sigma(t)=|z'(t)|=|w(t)|^2,
\qquad
S(t)=\int\sigma(t)\,dt.
\]

### 8.2 Fixed periodic topology

For \(N=64\) logical gate intervals, use \(2N=128\) uniform quadratic B-spline spans and 128 independent complex controls. The global period is \(T=N\), and each compiled span has global width

\[
h=\frac12.
\]

The preimage monodromy is fixed to \(\eta=-1\), because every accepted racing line is a regular simple closed planar curve with turning number \(\pm1\). Thus

\[
w^{(k)}(t+T)=-w^{(k)}(t),\quad k=0,1,
\]

while \(w^2\), the curve tangent, speed, curvature, and all physical curve values are periodic.

### 8.3 Uniform quadratic Bézier extraction

For span \(j\), obtain extended controls with the antiperiodic rule in Section 5.4 and define

\[
b_0=\frac{c_{j-1}+c_j}{2},
\qquad b_1=c_j,
\qquad b_2=\frac{c_j+c_{j+1}}{2}.
\]

For local \(\nu\in[0,1]\),

\[
w(\nu)=b_0(1-\nu)^2+2b_1\nu(1-\nu)+b_2\nu^2.
\]

Its local derivative is

\[
w_\nu(\nu)=2\left[(b_1-b_0)(1-\nu)+(b_2-b_1)\nu\right].
\]

### 8.4 Hodograph and speed coefficients

Define degree-4 Bernstein hodograph coefficients

\[
\begin{aligned}
q_0&=b_0^2,\\
q_1&=b_0b_1,\\
q_2&=\frac{b_0b_2+2b_1^2}{3},\\
q_3&=b_1b_2,\\
q_4&=b_2^2.
\end{aligned}
\]

Then

\[
\frac{dz}{d\nu}=h\sum_{k=0}^4q_kB_k^4(\nu).
\]

Define real degree-4 speed coefficients

\[
\begin{aligned}
r_0&=|b_0|^2,\\
r_1&=\operatorname{Re}(\overline b_0b_1),\\
r_2&=\frac{\operatorname{Re}(\overline b_0b_2)+2|b_1|^2}{3},\\
r_3&=\operatorname{Re}(\overline b_1b_2),\\
r_4&=|b_2|^2.
\end{aligned}
\]

Then

\[
\frac{ds}{d\nu}=h\sum_{k=0}^4r_kB_k^4(\nu)=h|w(\nu)|^2.
\]

The general coefficient identity, used by tests, is

\[
q_k=\sum_{a+b=k}
\frac{\binom2a\binom2b}{\binom4k}b_ab_b,
\qquad
r_k=\sum_{a+b=k}
\frac{\binom2a\binom2b}{\binom4k}b_a\overline b_b.
\]

Production SHALL evaluate the explicit real formulas above and SHALL NOT form a complex \(r_k\) and silently discard its imaginary part. The general complex identity is a test formula only.

### 8.5 Position and exact arc length

Let \(p_0\) be the exact span start point. Quintic position Bézier controls are

\[
p_{k+1}=p_k+\frac h5q_k,
\qquad k=0,\ldots,4.
\]

The span point is

\[
z(\nu)=\sum_{k=0}^5p_kB_k^5(\nu).
\]

The arc-length Bézier coefficients are

\[
A_0=0,
\qquad
A_{k+1}=A_k+\frac h5r_k.
\]

The exact forward length polynomial is

\[
S_f(\nu)=\sum_{k=0}^5A_kB_k^5(\nu),
\]

and the exact span length is

\[
L=A_5=\frac h5\sum_{k=0}^4r_k.
\]

The reverse polynomial SHALL be compiled once as

\[
S_r(v)=L-S_f(1-v).
\]

All authoritative polynomial evaluation SHALL use de Casteljau evaluation. GPU fast paths MAY use Horner form only if the binary64 certifier uses Bernstein form.

### 8.6 Tangent, normal, and curvature

For \(w\ne0\),

\[
T=\frac{w^2}{|w|^2}.
\]

Numerically, first compute \(\widehat w=w/|w|=(a,b)\), then

\[
T_x=(a-b)(a+b),
\qquad T_y=2ab.
\]

The left and right normals are

\[
N_L=iT=(-T_y,T_x),
\qquad N_R=-N_L.
\]

Signed curvature in physical units is

\[
\boxed{
\kappa(\nu)=
\frac{2\operatorname{Im}(\overline{w(\nu)}w_\nu(\nu))}
{h|w(\nu)|^4}
}.
\]

Curvature SHALL NOT be computed by finite differences.

### 8.7 Regularity certificate

A span is regular only if \(w(\nu)\ne0\) for all \(\nu\in[0,1]\). Certification SHALL recursively subdivide the quadratic preimage Bézier polygon.

For complex Bézier controls \(d_k\), define the axis-aligned hull

\[
[x_-,x_+]\times[y_-,y_+]
\]

from their real and imaginary components. Its squared distance lower bound from the origin is

\[
D^2=
\operatorname{dist}(0,[x_-,x_+])^2+
\operatorname{dist}(0,[y_-,y_+])^2,
\]

where

\[
\operatorname{dist}(0,[a,b])=
\begin{cases}
a,&a>0,\\
-b,&b<0,\\
0,&a\le0\le b.
\end{cases}
\]

If \(D^2>0\), it is a certified lower bound for \(|w|^2\) on the cell. Otherwise subdivide at \(\nu=1/2\) by de Casteljau. Binary64 certification SHALL continue until it proves

\[
|w|^2\ge \sigma_{\min}=10^{-10}\sigma_{\mathrm{ref}}
\]

or reaches depth 40, in which case the candidate is rejected. Here

\[
\sigma_{\mathrm{ref}}=\frac{L_{\mathrm{center}}}{T}.
\]

The GPU SHALL use the stronger margin \(10^{-6}\sigma_{\mathrm{ref}}\) and a maximum subdivision depth of 8. Ambiguity means rejection, never acceptance.

### 8.8 Playback-only arc-length inverse

Inverse arc length is not part of racing-line optimization or validation. The optimizer, track compiler, geometric certifier, and dynamic certifier SHALL use native PH parameter intervals and the exact forward arc-length polynomial from Section 8.6. They SHALL NOT call this inverse. This rule applies to WGSL and C99 code and SHALL be enforced by keeping the inverse symbol out of the optimizer and certificate library interfaces.

Playback must map a distance already traveled on one profile edge back to a display parameter. A generic quintic arc-length polynomial has no inverse by radicals, so this low-rate display query uses the bounded numerical procedure below. Its cost is independent of candidate throughput and cannot change lap time or feasibility.

Use a 16-cell monotone LUT plus bracketed Newton.

For target \(s\in[0,L]\):

1. Return 0 or 1 exactly at the endpoints.
2. Use the reverse polynomial when \(s>L/2\).
3. Locate the LUT cell by binary search.
4. Interpolate a seed inside the cell bracket.
5. Iterate at most 12 times:
   \[
   \nu_N=\nu-\frac{S(\nu)-s}{h|w(\nu)|^2}.
   \]
6. Replace a nonfinite or out-of-bracket Newton proposal by the bracket midpoint.
7. Update the bracket from the residual sign after every evaluation.
8. Accept in binary64 only when
   \[
   |S(\nu)-s|\le64\epsilon L+4\operatorname{ulp}(s).
   \]
9. Reject if the residual is not met after 12 Newton/bisection steps followed by at most 52 pure bisections.

Only playback and an explicit UI diagnostic `point-at-distance` query MAY use this inverse. Optimizer proposals, PH projection, regularity, exact offsets, swept-rectangle containment, self-intersection checks, speed-envelope construction, dynamic feasibility, adaptive validation, lap-time calculation, SAVE certification, and track compilation SHALL NOT use inverse-length queries. Their edge lengths are exact forward differences

\[
\Delta s=S_f(\nu_b)-S_f(\nu_a).
\]

The inverse routine SHALL be compiled in a separate C translation unit, `c/src/op_playback_inverse.c`. No optimizer or certification target SHALL link that object. The browser playback module MAY link it. This build boundary makes accidental hot-path use impossible.

### 8.9 Exact rational offset

For signed left offset \(d\),

\[
z_d(\nu)=z(\nu)+d\,i\frac{w(\nu)^2}{|w(\nu)|^2}
=\frac{z(\nu)R(\nu)+diQ(\nu)}{R(\nu)},
\]

where \(Q=w^2\) and \(R=|w|^2\) are degree 4. This is an exact rational degree-9 curve.

For degree-5 position controls \(p_i\), degree-4 speed controls \(r_j\), and degree-4 hodograph controls \(q_j\), define degree-9 coefficients

\[
M_k=\sum_{i+j=k}
\frac{\binom5i\binom4j}{\binom9k}p_ir_j,
\]

\[
W_k=\sum_j
\frac{\binom4j\binom5{k-j}}{\binom9k}r_j,
\]

\[
Q_k^{\uparrow9}=\sum_j
\frac{\binom4j\binom5{k-j}}{\binom9k}q_j,
\]

where invalid binomial indices contribute zero. The homogeneous control is

\[
H_k=M_k+diQ_k^{\uparrow9},
\]

and the rational Bézier control is

\[
o_k=H_k/W_k
\quad\text{with weight }W_k.
\]

If any \(W_k\le0\), subdivide the source preimage span exactly at \(1/2\) and rebuild. A regular span has positive denominator pointwise, so recursive subdivision eventually yields positive weights. Failure by depth 24 is a construction error.

### 8.10 Offset length

Let \(\theta(\nu)=2\arg w(\nu)\) be the continuously unwrapped tangent angle. The offset derivative is

\[
\frac{dz_d}{ds}=(1-d\kappa)T.
\]

For the supported cusp-free orientation-preserving offsets,

\[
S_d(\nu)=S_f(\nu)-d\,[\theta(\nu)-\theta(0)].
\]

The tangent-angle increment SHALL use a continuous `atan2(cross,dot)` accumulation over preimage subdivision cells; it SHALL NOT subtract two independently wrapped angles. For a complete simple closed loop with turning number \(n_T\in\{-1,+1\}\),

\[
L_d=L-2\pi n_Td.
\]

Version 1 does not require offset inverse length and SHALL NOT expose it to track compilation, optimization, certification, or rendering. An optional diagnostic-only implementation MAY use the guarded bracketed Newton structure from Section 8.8 with derivative

\[
\frac{dS_d}{d\nu}=h|w|^2(1-d\kappa)>0.
\]

### 8.11 Minimum curvature radii

For a quintic span, compute certified extrema of signed curvature by recursive Bernstein interval subdivision of

\[
\kappa=\frac{2A}{hR^2},
\qquad
A=\operatorname{Im}(\overline w w_\nu),
\qquad R=|w|^2>0.
\]

Subdivision stops when the curvature interval width is at most

\[
10^{-12}\max(1,|\kappa|)
\]

or at depth 48. Failure to reach a bound rejects track compilation. Aggregate

\[
\rho_L=\frac1{\max(\kappa_{\max},0)},
\qquad
\rho_R=\frac1{\max(-\kappa_{\min},0)},
\]

with \(1/0=+\infty\).

### 8.12 Required PH leverage in the hot path

This application is a PH-spline demonstration. The implementation SHALL use each algebraic PH property below in the stated production operation. A replacement by generic quadrature, finite differences, closest-point searches, or generic nonlinear root finding is nonconforming.

| PH property | Fixed algebraic object | Mandatory use |
|---|---|---|
| Hodograph factorization | \(z_\nu=h w^2\), degree 4 | construct tangent direction and local displacement constraints |
| Polynomial speed | \(\sigma=h|w|^2\), degree 4 | exact edge length, regularity bounds, and time-profile grid lengths |
| Polynomial forward arc length | \(S_f\), degree 5 | every optimizer and validator \(\Delta s\); no quadrature |
| Rational unit tangent and normal | \(T=w^2/|w|^2\), \(N=iT\) | dynamics, vehicle orientation, and swept-corner construction |
| Rational curvature | \(\kappa=2\operatorname{Im}(\overline w w_\nu)/(h|w|^4)\) | fixed-degree interval bounds and lateral-force limits |
| Exact rational offset | degree-9 homogeneous controls from Section 8.9 | track boundaries and corridor construction |
| Rational rectangle corners | \(z+(\pm L_e/2\pm iW_e/2)T\), degree 9 | continuous swept-rectangle containment by Bernstein coefficient tests |
| Quadratic-preimage local structure | fixed Gram matrix and analytic Jacobian | deterministic local projection after every genotype mutation |
| Bernstein convex-hull property | fixed degrees 2, 4, and 9 | regularity, curvature, offsets, and containment certificates |

The GPU candidate kernel SHALL stay entirely in the native span parameter \(\nu\). For fixed node parameters \(\nu_i\), it obtains all edge lengths from forward polynomial differences, evaluates analytic curvature and rectangle inequalities, and solves the speed envelope. It SHALL contain no adaptive quadrature loop, arc-length inverse, closest-point query, generic polynomial solver, finite-difference tangent, or finite-difference curvature.

Ordinary polynomial splines can also be optimized on a GPU, so the implementation SHALL NOT claim that PH splines make the task possible in an absolute sense. The demonstrable PH advantage is narrower and testable: exact forward length, exact rational offsets, rational frame fields, and fixed-degree continuous containment replace numerical quadrature and approximation in the candidate hot path. Section 25 SHALL report hot-path quadrature and inverse iterations as zero and compare PH length evaluation with the fully specified ordinary-quintic composite-Simpson microbenchmark. The baseline is diagnostic and never ranks candidates in the production optimizer.

## 9. Racing-line construction and local mutation

### 9.1 Genotype

The optimizer genotype is one signed lateral gate value per track gate:

\[
d_i\in[-d_R,d_L],\qquad i=0,\ldots,63.
\]

The interpolation point is

\[
P_i=C_i+d_iN_c(i/64).
\]

The initial genotype is \(d_i=0\), so the first line is the centerline. A genotype is not feasible merely because every \(d_i\) is in range. The complete PH curve and swept rectangle SHALL still pass all certificates.

Define cyclic displacements

\[
D_i=P_{i+1\bmod64}-P_i.
\]

They telescope structurally:

\[
\sum_{i=0}^{63}D_i=0.
\]

### 9.2 Exact displacement constraints

Logical gate interval \(i\) consists of compiled spans \(2i\) and \(2i+1\). Let the extracted preimage controls of a span be \(b=(b_0,b_1,b_2)^T\). Define the exact quadratic Bernstein Gram matrix

\[
G=
\begin{bmatrix}
1/5&1/10&1/30\\
1/10&2/15&1/10\\
1/30&1/10&1/5
\end{bmatrix}.
\]

The complex displacement of one span is

\[
\Phi(b)=h\,b^TGb.
\]

The authoritative interpolation residual is

\[
F_i(c)=\Phi(b_{2i})+\Phi(b_{2i+1})-D_i=0.
\]

These are exactly 64 complex, or 128 real, equations. Numerical quadrature SHALL NOT be used in construction.

When compiling position controls, set the first span of logical interval \(i\) to

\[
p_{2i,0}=P_i,
\]

and the second span to

\[
p_{2i+1,0}=P_i+\Phi(b_{2i}).
\]

Then apply Section 8.5. The accepted constraint makes the second span end at \(P_{i+1}\), including \(P_{64}=P_0\) at the seam. This rule is authoritative; position SHALL NOT be reconstructed by accumulating all preceding spans at query time.

### 9.3 Analytic Jacobian

For local preimage control \(b_k=x_k+iy_k\), define

\[
v_k=2h\sum_{a=0}^2G_{ka}b_a.
\]

Then

\[
\frac{\partial\Phi}{\partial x_k}=v_k,
\qquad
\frac{\partial\Phi}{\partial y_k}=iv_k.
\]

Each extracted control is a real linear combination of three global controls:

\[
\begin{bmatrix}b_0\\b_1\\b_2\end{bmatrix}
=
\begin{bmatrix}
1/2&1/2&0\\
0&1&0\\
0&1/2&1/2
\end{bmatrix}
\begin{bmatrix}c_{j-1}\\c_j\\c_{j+1}\end{bmatrix}.
\]

Apply the chain rule with this extraction matrix. Convert a complex derivative \(a+ib\) of complex residual \(F\) into the real Jacobian columns:

\[
\frac{\partial(\operatorname{Re}F,\operatorname{Im}F)}{\partial x}
=(a,b)^T,
\qquad
\frac{\partial(\operatorname{Re}F,\operatorname{Im}F)}{\partial y}
=(-b,a)^T.
\]

Finite-difference Jacobians are forbidden in production. They MAY be used only as a test oracle.

### 9.4 Deterministic initial seed

For each gate, define the uniform guide velocity

\[
v_i=\frac{D_{i-1}+D_i}{2}.
\]

If

\[
|v_i|\le32\epsilon\max(|D_{i-1}|,|D_i|),
\]

replace it by the longer adjacent displacement; exact ties select \(D_{i-1}\).

Compute the principal complex square root of \(v=x+iy\) by

\[
u=\sqrt{\frac{|v|+x}{2}},
\qquad
q=\operatorname{copysign}\left(\sqrt{\frac{|v|-x}{2}},y\right),
\qquad
r=u+iq.
\]

When \(u=0\), set \(q=\operatorname{copysign}(\sqrt{|v|},y)\). Use scaled `hypot` for \(|v|\).

Choose signs \(s_i\in\{-1,+1\}\) by a two-state dynamic program that minimizes

\[
\sum_{i=1}^{63}|s_ir_i-s_{i-1}r_{i-1}|^2
+|s_{63}r_{63}+s_0r_0|^2.
\]

The plus sign in the seam term enforces antiperiodicity. Exact dynamic-programming ties select \(s_i=+1\). Linearly interpolate the signed roots at half-gate positions to seed the 128 controls. The seed is not authoritative until projection and verification finish.

### 9.5 Minimum-norm nonlinear projection

Let \(x\) contain real and imaginary parts of the selected free complex controls, let \(F(x)\) contain real and imaginary constraint residuals, and let \(J\) be the analytic real Jacobian. Every iteration solves

\[
\min_{\delta}\|\delta\|_2
\quad\text{subject to}\quad
J\delta=-F.
\]

Let \(A=J^T\), with \(A\) of size \(n\times m\), \(n\ge m\). Compute deterministic Householder QR with column pivoting:

\[
AP=QR.
\]

At QR step \(k\), pivot the remaining column with largest squared 2-norm; exact ties choose the smallest original column index. With

\[
A=QRP^T,
\qquad J=PR^TQ^T,
\]

solve

\[
R^Ty=-P^TF
\]

by forward substitution and set

\[
\delta=Q_{[:,0:m]}y.
\]

Householder reflectors SHALL be formed with the sign that avoids subtraction:

\[
\alpha=-\operatorname{copysign}(\|x\|_2,x_0),
\qquad v=x-\alpha e_0,
\qquad \tau=2/(v^Tv).
\]

Reject rank deficiency when

\[
|R_{kk}|\le r_{\mathrm{tol}}|R_{00}|.
\]

Use \(r_{\mathrm{tol}}=10^{-7}\) on the GPU and \(10^{-12}\) in binary64.

Try step factors

\[
\alpha\in\{1,1/2,1/4,1/8,1/16,1/32,1/64,1/128\}
\]

and accept the first finite trial with a strictly smaller residual 2-norm and no immediate regularity failure. If none is accepted, the solve fails.

GPU construction permits at most 12 nonlinear iterations and accepts only when

\[
\max_i|F_i|\le2\times10^{-5}H.
\]

Binary64 construction permits at most 40 iterations and accepts only when

\[
\max_i|F_i|\le10^{-10}H.
\]

After convergence, compile every affected span and independently verify interpolation, seam position, tangent, curvature, regularity, and positive length. Solver convergence alone is never acceptance.

### 9.6 Strict-local one-gate edit

A single-gate mutation changes exactly the two adjacent displacement targets. Select a cyclic patch of \(K=5\) logical intervals centered on those targets. In an unwrapped patch beginning at logical interval \(a\), the affected spans are

\[
j=2a,\ldots,2(a+K)-1.
\]

They depend on extended controls

\[
c_{2a-1},\ldots,c_{2(a+K)}.
\]

To keep every exterior span bitwise unchanged, freeze

\[
c_{2a-1},\ c_{2a},\ c_{2(a+K)-1},\ c_{2(a+K)}.
\]

The free controls are

\[
c_{2a+1},\ldots,c_{2(a+K)-2},
\]

which gives \(2K-2=8\) complex unknowns for \(K=5\) complex constraints. The remaining three complex degrees of freedom select the nearby branch through the minimum-norm correction.

Because all five displacement constraints are enforced and the patch boundary gates are unchanged,

\[
\int_{a}^{a+K}\left(w_{\mathrm{new}}^2-w_{\mathrm{old}}^2\right)dt=0.
\]

Therefore no downstream translation occurs. Because the same uniform B-spline control sequence remains in use, \(w\in C^1\), hence the PH curve remains \(C^2\) and curvature-continuous structurally.

### 9.7 Three-gate edit

A three-gate mutation changes three consecutive gate offsets with weights

\[
(1/4,1/2,1/4)\Delta d.
\]

Use \(K=7\) logical intervals and the same two-control freeze at each end. It has 12 free complex controls for seven complex constraints. No other block width is supported in version 1.

### 9.8 Seam-crossing patch

Solve a seam-crossing patch in an unwrapped lifted gauge. For unwrapped control index \(j=qn+r\), \(0\le r<n\), use

\[
\widetilde c_j=(-1)^qc_r.
\]

After the solve, write each result back as

\[
c_r=(-1)^q\widetilde c_j.
\]

Then verify the stored seam with sign \(-1\) for preimage values and derivatives and sign \(+1\) for physical curve values.

### 9.9 Atomicity

An edit SHALL be private until all checks pass. Failure leaves the parent genotype, controls, span kernels, speed profile, lap time, and version unchanged. Accepted GPU states are provisional. A published or saved state SHALL be rebuilt independently from its genotype in binary64.

### 9.10 Simple racing-line certificate

The racing line SHALL have no self-intersection. For quintic polynomial spans

\[
P(u)=\sum_{a=0}^5p_aB_a^5(u),
\qquad
Q(v)=\sum_{b=0}^5q_bB_b^5(v),
\]

the bivariate Bernstein coefficients of their difference are

\[
D_{ab}=p_a-q_b,
\qquad a,b=0,\ldots,5,
\]

because both Bernstein bases sum to one. A parameter box has no intersection when the real coefficient hull or imaginary coefficient hull of \(D\) excludes zero. Otherwise subdivide the larger parameter dimension by de Casteljau.

For two nonadjacent spans, any isolated root is invalid. Adjacent spans may share only the prescribed endpoint. For one span, search the half-domain \(0\le u<v\le1\); ignore only the diagonal root \(u=v\). Boxes whose two parameter intervals overlap SHALL be split until they are disjoint or lie wholly in an arbitrarily small diagonal neighborhood. A root in disjoint parameter intervals is a self-intersection.

The GPU retests every rebuilt span against all spans whose Bézier hull boxes overlap, using a track-built span BVH and subdivision depth 8. Ambiguity means candidate rejection. It also tests every pair of rebuilt spans and each rebuilt span against itself. The binary64 certifier tests every overlapping span pair to depth 48 and resolves remaining boxes with 2D interval Newton. The seam-adjacent first and last spans follow the ordinary adjacent-endpoint rule.

The exact signed area of one span is

\[
\mathcal A_{\mathrm{span}}=
\frac12\operatorname{Im}\left[
\sum_{a=0}^5\sum_{b=0}^4
\overline p_a(hq_b)
\frac{\binom5a\binom4b}{10\binom9{a+b}}
\right].
\]

Sum spans with compensation. The racing-line signed-area sign SHALL equal the track centerline sign and its absolute area SHALL be positive. Together with ordered gate interpolation, corridor assignment, and simplicity, this fixes one forward traversal of the lane rather than a reversed or extra-winding loop.

## 10. Continuous finite-vehicle containment

### 10.1 Effective vehicle rectangle

Inputs are vehicle length \(L_v\), vehicle width \(W_v\), and safety margin \(m_s\). Define

\[
L_e=L_v+2m_s,
\qquad W_e=W_v+2m_s.
\]

The reference point is the rectangle center. At racing-line parameter \(\nu\), its four corners are

\[
C_{\epsilon_l,\epsilon_w}(\nu)=
z(\nu)+\epsilon_l\frac{L_e}{2}T(\nu)
+\epsilon_w\frac{W_e}{2}N_L(\nu),
\]

where \(\epsilon_l,\epsilon_w\in\{-1,+1\}\).

The complete instantaneous vehicle is the convex hull of these corners. The swept surface over an interval \(I\) is

\[
\mathcal S(I)=\bigcup_{\nu\in I}\operatorname{conv}
\{C_{-,-},C_{-,+},C_{+,-},C_{+,+}\}.
\]

The legal condition is

\[
\mathcal S([0,1])\subseteq\mathcal L,
\]

where \(\mathcal L\) is the exact track lane. Boundary contact is legal. Crossing outside by any positive amount is illegal.

### 10.2 Rational corner trajectory

Let

\[
A_{\epsilon_l,\epsilon_w}
=\epsilon_l\frac{L_e}{2}+i\epsilon_w\frac{W_e}{2}.
\]

Using \(T=Q/R\) and \(N_L=iQ/R\),

\[
\boxed{
C_{\epsilon_l,\epsilon_w}(\nu)
=\frac{z(\nu)R(\nu)+A_{\epsilon_l,\epsilon_w}Q(\nu)}{R(\nu)}
}.
\]

The numerator has degree 9 and the denominator has degree 4. This exact formula uses vehicle length and width independently. The implementation SHALL NOT replace the rectangle with a half-diagonal disk.

### 10.3 Convex-cell half-space certificate

For a corridor half-space

\[
n\cdot x\le b,
\]

and positive \(R\), one corner is inside for the whole interval if and only if

\[
G(\nu)=bR(\nu)-n\cdot\left(z(\nu)R(\nu)+AQ(\nu)\right)\ge0
\]

for the whole interval. Elevate all terms to degree 9 using the product and elevation coefficients in Section 8.9.

If every degree-9 Bernstein coefficient of \(G\) is nonnegative, then \(G\ge0\) on the full interval. If every coefficient is negative, the interval violates the half-space. A mixed sign is unresolved and requires subdivision.

A swept interval is certified in a convex cell only when all four corner trajectories pass every half-space. Since the cell is convex, the entire rectangle at every parameter and thus the complete swept surface of the interval are inside the cell.

### 10.4 Search-time certificate

Each of the 128 PH spans SHALL be split once at \(\nu=1/2\), producing 256 containment and dynamics microintervals. The track asset provides up to eight candidate corridor-cell IDs per microinterval.

For each candidate cell, the GPU SHALL test all four corners and all cell half-spaces. It accepts the microinterval if one complete cell has

\[
\min_kG_k\ge \delta_{\mathrm{gpu}},
\qquad
\delta_{\mathrm{gpu}}=\frac{0.00025\ \mathrm m}{H}R_{\mathrm{scale}},
\]

where \(R_{\mathrm{scale}}\) is the maximum absolute denominator coefficient used in that inequality. If no candidate cell passes, the racing-line candidate is infeasible. This 0.25 mm search clearance is numerical protection, not an added physical safety margin.

### 10.5 Binary64 adaptive certificate

The certifier begins with the same 256 microintervals. For each interval:

1. Try every listed overlapping cell.
2. Accept the interval when one cell certifies all inequalities with outward-rounded binary64 intervals.
3. If no cell certifies and any point interval is proven outside every relevant cell, reject.
4. Otherwise subdivide the PH interval at its midpoint and repeat on both children with inherited candidate cells plus neighboring cells.
5. Stop at depth 40. An unresolved interval is rejected as uncertified.

The final certificate uses \(G\ge0\) with no artificial clearance. A profile may touch a legal boundary if interval arithmetic proves nonnegativity.

### 10.6 Outward-rounded interval arithmetic

The C99 core SHALL implement closed intervals. `op_next_down` and `op_next_up` move one binary64 representable value by integer bit ordering, with explicit handling for zero and infinities. Their bit conversions SHALL use `memcpy`, not aliasing casts.

For \(X=[a,b]\), \(Y=[c,d]\):

\[
X+Y=[\operatorname{nextDown}(a+c),\operatorname{nextUp}(b+d)],
\]

\[
X-Y=[\operatorname{nextDown}(a-d),\operatorname{nextUp}(b-c)],
\]

\[
XY=[\operatorname{nextDown}(m),\operatorname{nextUp}(M)],
\]

where \(m\) and \(M\) are the minimum and maximum of \(ac,ad,bc,bd\). Division multiplies by

\[
1/Y=[\operatorname{nextDown}(1/d),\operatorname{nextUp}(1/c)]
\]

and is forbidden if \(0\in Y\). Every input decimal is first converted to the enclosing one-ULP interval around its parsed binary64 value.

### 10.7 Containment theorem used by the implementation

For each parameter subinterval \(I_k\), the certifier proves

\[
\mathcal S(I_k)\subseteq C_k
\]

for a convex cell \(C_k\), and the track compiler has already proved

\[
C_k\subseteq\mathcal L.
\]

Therefore

\[
\mathcal S([0,1])
=\bigcup_k\mathcal S(I_k)
\subseteq\bigcup_k C_k
\subseteq\mathcal L.
\]

This is the required no-exit guarantee. It accounts for the front and rear overhang continuously and permits near-boundary use without shrinking the lane by the rectangle half-diagonal.

## 11. Vehicle and aerodynamic model

### 11.1 Inputs and defaults

| Input | Symbol | Default | Allowed range |
|---|---:|---:|---:|
| vehicle mass | \(m_v\) | 900 kg | 100–5000 kg |
| vehicle length | \(L_v\) | 4.8 m | 1–15 m |
| vehicle width | \(W_v\) | 2.0 m | 0.5–5 m |
| safety margin | \(m_s\) | 0.05 m | 0–2 m |
| hard maximum speed | \(v_{\max}\) | 91.6667 m/s (330 km/h) | 1–150 m/s |
| base traction acceleration | \(a_{x,+0}\) | 6.0 m/s² | 0.1–30 m/s² |
| base braking acceleration | \(a_{x,-0}\) | 14.0 m/s² | 0.1–50 m/s² |
| base lateral acceleration | \(a_{y,0}\) | 15.0 m/s² | 0.1–50 m/s² |
| ellipse exponent | \(p\) | 2.0 | 1–8 |
| drag area | \(C_DA\) | 1.0 m² | 0–10 m² |
| downforce area | \(C_LA\) | 3.0 m² | 0–20 m² |
| air density | \(\rho\) | 1.225 kg/m³ | 0.5–1.5 kg/m³ |
| gravity | \(g\) | 9.80665 m/s² | fixed |
| maximum curvature | \(\kappa_{\max}\) | disabled | 0.001–2 1/m when enabled |

All inputs SHALL be finite. Length and width are first-class profile inputs and SHALL be stored with every saved profile.

### 11.2 Aerodynamic forces

For \(q=v^2\), drag magnitude is

\[
F_D(q)=\frac12\rho C_DAq.
\]

Downforce magnitude is

\[
F_L(q)=\frac12\rho C_LAq.
\]

Define

\[
\delta=\frac{\rho C_DA}{2m_v},
\qquad
\gamma=\frac{\rho C_LA}{2m_vg}.
\]

Then drag acceleration is

\[
a_D(q)=\delta q,
\]

and the tire normal-load multiplier is

\[
\Lambda(q)=1+\gamma q.
\]

Thus higher speed increases available tire force through downforce, while drag opposes motion.

### 11.3 Force-based acceleration ellipse

For signed net tangential acceleration \(a_t\), the signed tire acceleration demand is

\[
a_{\mathrm{tire},x}=a_t+\delta q.
\]

Lateral tire acceleration demand is

\[
a_{\mathrm{tire},y}=q\kappa.
\]

Select the longitudinal base limit

\[
a_{x,0}=
\begin{cases}
a_{x,+0},&a_{\mathrm{tire},x}\ge0,\\
a_{x,-0},&a_{\mathrm{tire},x}<0.
\end{cases}
\]

The exact stability utilization is

\[
\boxed{
U(q,a_t,\kappa)=
\left[
\left(\frac{|a_t+\delta q|}{a_{x,0}\Lambda(q)}\right)^p
+
\left(\frac{|q\kappa|}{a_{y,0}\Lambda(q)}\right)^p
\right]^{1/p}
}.
\]

Feasibility requires

\[
U\le1.
\]

This model uses tire-force capacity, not net acceleration, inside the ellipse. Drag therefore consumes positive traction during constant-speed running and assists net braking.

### 11.4 Constant-speed cap

For an interval curvature bound \(K\ge|\kappa|\), define

\[
C(K)=
\left[
\left(\frac\delta{a_{x,+0}}\right)^p
+\left(\frac K{a_{y,0}}\right)^p
\right]^{1/p}.
\]

At constant speed, feasibility is

\[
\frac{qC(K)}{1+\gamma q}\le1.
\]

Therefore the exact conservative cap is

\[
q_{\mathrm{steady}}(K)=
\begin{cases}
+\infty,&C(K)\le\gamma,\\
1/(C(K)-\gamma),&C(K)>\gamma.
\end{cases}
\]

The node cap is

\[
q_{\mathrm{cap}}=min(v_{\max}^2,q_{\mathrm{steady}}(K)).
\]

If maximum curvature is enabled, any interval with \(K>\kappa_{\max}\) is infeasible regardless of speed.

### 11.5 Remaining longitudinal capacity

For a speed-squared interval \(q\in[q_l,q_h]\), define the worst lateral fraction

\[
u_y^h=\frac{q_hK}{a_{y,0}\Lambda(q_h)}.
\]

If \(u_y^h>1\), the interval is infeasible. Otherwise define

\[
R_h=\left(1-(u_y^h)^p\right)^{1/p}.
\]

Because \(\Lambda\) is increasing and \(R\) is decreasing with \(q\), conservative lower bounds on the remaining tire acceleration are

\[
G_+(q_l,q_h,K)=a_{x,+0}\Lambda(q_l)R_h,
\]

\[
G_-(q_l,q_h,K)=a_{x,-0}\Lambda(q_l)R_h.
\]

These bounds are used by the speed solver. They are intentionally conservative and require no unspecific interpolation or force sampling.

## 12. Periodic speed profile and lap time

### 12.1 Dynamic grid

The search grid has one node at each half of each of the 128 PH spans, for 256 periodic nodes and 256 edges. For edge \(i\), compile:

- exact racing-line arc length \(\Delta s_i>0\);
- certified curvature-magnitude upper bound \(K_i\);
- starting and ending PH locations; and
- corridor certificate status.

The exact length is a difference of the span arc polynomial. It SHALL NOT use chord length.

For a subdivided preimage cell, bound curvature by

\[
K_i\le
\frac{2\max|A|}{h_i(\min R)^2},
\qquad
A=\operatorname{Im}(\overline w w_\nu),
\qquad R=|w|^2.
\]

The maximum of \(|A|\) is bounded by the largest absolute Bernstein coefficient of \(A\). The minimum of \(R\) comes from the regularity hull certificate. Binary64 incumbent evaluation recursively subdivides until the relative bound gap is below \(10^{-8}\) or depth 32.

To compile \(A\), let the degree-1 controls of \(w_\nu\) be

\[
d_0=2(b_1-b_0),
\qquad d_1=2(b_2-b_1).
\]

Its degree-3 Bernstein coefficients are explicitly

\[
A_k=\operatorname{Im}\left(
\sum_{a+b=k}
\frac{\binom2a\binom1b}{\binom3k}
\overline b_a d_b
\right),
\qquad k=0,\ldots,3.
\]

### 12.2 Piecewise speed model

On edge \(i\), squared speed is linear in traveled distance \(x\in[0,\Delta s_i]\):

\[
q(x)=q_i+\frac{q_{i+1}-q_i}{\Delta s_i}x.
\]

Therefore net tangential acceleration is constant:

\[
a_i=\frac{q_{i+1}-q_i}{2\Delta s_i}.
\]

This equation defines the version-1 dynamic discretization. No hidden time-step integrator is permitted.

Let

\[
q_l=\min(q_i,q_{i+1}),
\qquad q_h=\max(q_i,q_{i+1}).
\]

The complete continuous edge is certified feasible when

\[
X_+=\max(0,a_i+\delta q_h)\le G_+(q_l,q_h,K_i),
\]

and

\[
X_-=\max(0,-a_i-\delta q_l)\le G_-(q_l,q_h,K_i).
\]

These inequalities cover every intermediate \(q\), because signed tire demand \(a_i+\delta q\) is monotone in \(q\), while \(G_+\) and \(G_-\) are lower bounds over the whole interval.

### 12.3 Forward reach map

Given start \(q_0\), target cap \(q_c\ge q_0\), edge length \(\Delta s\), and curvature bound \(K\), define `forward_reach` as the greatest \(q\in[q_0,q_c]\) satisfying

\[
\frac{q-q_0}{2\Delta s}+\delta q
\le G_+(q_0,q,K).
\]

The left side increases with \(q\); the right side does not increase. The feasible set is therefore one prefix interval. Return \(q_c\) if it passes. Otherwise perform exactly 20 bisection steps on \([q_0,q_c]\) and return the feasible lower endpoint. If \(q_c\le q_0\), return \(q_c\) unchanged because braking is handled by the backward map.

### 12.4 Backward braking reach map

Given next speed \(q_1\), starting cap \(q_c\ge q_1\), define `brake_reach` as the greatest \(q\in[q_1,q_c]\) satisfying both

\[
\delta q\le G_+(q_1,q,K)
\]

and

\[
\max\left(0,\frac{q-q_1}{2\Delta s}-\delta q_1\right)
\le G_-(q_1,q,K).
\]

The first inequality conservatively reserves enough positive tire force to compensate drag anywhere in the interval. The second ensures enough braking tire force at the low-speed end. Both become no easier as \(q\) grows, so the feasible set is one prefix interval. Use the same 20-step bisection. If \(q_c\le q_1\), return \(q_c\).

### 12.5 Cyclic maximal envelope

For node \(i\), use

\[
K_i^{\mathrm{node}}=\max(K_{i-1},K_i)
\]

in the cap from Section 11.4. Initialize

\[
q_i^{(0)}=q_{\mathrm{cap},i}.
\]

Apply parallel Jacobi relaxation with periodic indexing:

\[
q_i^{(k+1)}=\min\left(
q_i^{(k)},
\operatorname{forward\_reach}(q_{i-1}^{(k)},q_i^{(k)},\Delta s_{i-1},K_{i-1}),
\operatorname{brake\_reach}(q_{i+1}^{(k)},q_i^{(k)},\Delta s_i,K_i)
\right).
\]

All maps only reduce the upper envelope and are monotone. Starting from the cap vector therefore converges to the greatest fixed point of the conservative edge constraints.

The GPU stops when

\[
\max_i|q_i^{(k+1)}-q_i^{(k)}|
\le\max(10^{-4},10^{-6}v_{\max}^2)
\]

or after 512 iterations. Failure to converge makes the candidate infeasible for that batch.

The binary64 certifier uses tolerance

\[
10^{-10}\max(1,v_{\max}^2)
\]

and at most 4096 iterations. It then rechecks every edge with Section 12.2. No unconverged profile may be published.

### 12.6 Periodicity

Indices are cyclic, including edge 255 from node 255 to node 0. No initial-speed input exists. The solver determines the maximum feasible periodic speed vector. Acceptance requires that the seam edge passes the same constraints as every other edge.

### 12.7 Exact edge time

With constant tangential acceleration on an edge, traversal time is exactly

\[
\Delta t_i=
\frac{2\Delta s_i}{\sqrt{q_i}+\sqrt{q_{i+1}}}.
\]

If the denominator is zero, the profile is infeasible. Accumulate lap time with Neumaier compensated summation:

\[
T_{\mathrm{lap}}=\sum_i\Delta t_i.
\]

Lap time is the only objective. Invalid candidates have score \(+\infty\). For exactly equal binary score bits, the lower deterministic candidate ID is selected only to make reductions reproducible; no secondary geometric score is used.

### 12.8 Adaptive incumbent profile

A provisional GPU winner is rebuilt in binary64 on a 1024-edge grid, with eight equal-parameter subdivisions per PH span. On STOP or SAVE, refine each edge recursively when any condition holds:

- the curvature interval relative gap exceeds \(10^{-8}\);
- its containment proof is unresolved;
- its maximum stability upper bound exceeds 0.999999;
- splitting changes the local time estimate by more than \(10^{-7}\) s; or
- the edge is longer than 2 m.

Refinement stops when total lap-time change between two complete levels is at most \(10^{-6}\) s and all certificates pass, or at 8192 edges. Failure by 8192 edges is a certification error, not success.

### 12.9 Playback interpolation

For elapsed profile time \(\tau\), binary-search cumulative edge times. Within one edge, let local elapsed time be \(t_e\), initial speed \(v_0=\sqrt{q_i}\), and acceleration \(a_i\). Traveled edge distance is

\[
x=v_0t_e+\frac12a_it_e^2.
\]

Clamp only within four binary64 ULPs of \([0,\Delta s_i]\); a larger excursion is an error. Convert the exact local arc target to PH parameter with Section 8.8. Vehicle orientation is the analytic tangent, not a finite difference of animation positions.

### 12.10 Chart samples

At chart sample time, report:

\[
v=\sqrt q,
\qquad a_t=a_i,
\qquad a_y=q\kappa,
\qquad U=U(q,a_i,\kappa).
\]

The stability line SHALL use the actual signed curvature at the sample. The feasibility certificate uses the interval upper bound.

## 13. Parallel optimizer

### 13.1 Algorithm

The version-1 search algorithm is massively parallel replica-exchange stochastic local search. It has 32 temperature levels and 32 replicas per level, for 1024 chains. Each chain stores one valid genotype and its compiled provisional PH state.

Before creating chains, select a seed in this order:

1. the explicitly selected compatible saved optimization seed;
2. the current certified profile when track and settings fingerprints match; or
3. the centerline genotype.

The seed SHALL pass binary64 PH, rectangle, and dynamic certification. If no valid seed exists, OPTIMIZE remains disabled and the UI reports the first failed certificate. Version 1 does not run a violation-minimizing feasibility search, because that would introduce a second geometric optimization objective.

The dimensionless temperature ladder is

\[
\tau_l=10^{-6+6l/31},
\qquad l=0,\ldots,31.
\]

Let \(T_0\) be the certified seed lap time, fixed for the run, and define energy

\[
E=T_{\mathrm{lap}}/T_0.
\]

Each chain proposes one local mutation per batch. A feasible proposal with energy \(E'\) replaces energy \(E\) when \(E'<E\), or otherwise with probability

\[
P_{\mathrm{accept}}=\exp\left(-\frac{E'-E}{\tau_l}\right).
\]

An infeasible proposal is always rejected. This exploration rule does not change the objective: global-best comparison uses lap time only.

### 13.2 Mutation

Choose a gate uniformly. With probability 7/8 perform the one-gate edit in Section 9.6. With probability 1/8 perform the three-gate edit in Section 9.7.

Generate an approximate standard normal variate without transcendental functions:

\[
Z=\sum_{j=1}^{12}U_j-6,
\qquad U_j\sim\operatorname{Uniform}(0,1).
\]

For level \(l\), initialize

\[
\sigma_l=W_{\mathrm{median}}
\min\left(0.25,0.002\,2^{l/4}\right),
\]

where \(W_{\mathrm{median}}=\operatorname{median}(d_L+d_R)\), which is the constant full width for version 1. Propose

\[
d_i'=d_i+\sigma_lZ.
\]

Reflect, do not clamp, into \([a,b]=[-d_R,d_L]\). With \(w=b-a\), set

\[
y=(d_i'-a)\bmod(2w),
\qquad
d_i^{\mathrm{reflected}}=
\begin{cases}
a+y,&y\le w,\\
b-(y-w),&y>w.
\end{cases}
\]

The modulo is the nonnegative real modulo.

### 13.3 Step adaptation

Each level records accepted value \(A\in\{0,1\}\). After every 32 local proposals per replica, update

\[
\log\sigma_l\leftarrow
\operatorname{clamp}\left(
\log\sigma_l+eta_n(A_{\mathrm{rate}}-0.234),
\log(10^{-5}W_{\mathrm{median}}),
\log(0.5W_{\mathrm{median}})
\right),
\]

with

\[
\eta_n=0.05/\sqrt{1+n/256}.
\]

The level update uses the mean acceptance rate across its 32 replicas and one deterministic reduction.

### 13.4 Replica exchange

Every 16 batches, attempt exchanges between adjacent temperature levels for corresponding replicas. Alternate pairs `(0,1),(2,3),...` and `(1,2),(3,4),...`. For states \(a,b\), accept the swap with probability

\[
P_{\mathrm{swap}}=
\min\left(1,
\exp\left[
(1/\tau_a-1/\tau_b)(E_a-E_b)
\right]
\right).
\]

Swap complete chain states, not only lap times. Global best is never overwritten.

### 13.5 Stagnation and restart

If one replica has no accepted move for 2048 proposals, rebuild it from the global-best genotype and apply eight sequential high-temperature one-gate mutations using the top-level step size. Each mutation must construct a valid PH line; retry each at most 16 times. If all retries fail, use the centerline genotype. This affects exploration only.

### 13.6 Deterministic random generator

Use Philox4x32-10 with multiplication constants

```text
M0 = 0xD2511F53
M1 = 0xCD9E8D57
W0 = 0x9E3779B9
W1 = 0xBB67AE85
```

One round maps counter `(c0,c1,c2,c3)` and key `(k0,k1)` to

```text
(hi0, lo0) = mul_hi_lo(M0, c0)
(hi1, lo1) = mul_hi_lo(M1, c2)
c0' = hi1 xor c1 xor k0
c1' = lo1
c2' = hi0 xor c3 xor k1
c3' = lo0
k0' = k0 + W0
k1' = k1 + W1
```

Apply ten rounds. The counter fields are `(batch_low, batch_high, chain_id, draw_block)`. The key is the user seed as two `u32` words.

WGSL `mul_hi_lo(a,b)` SHALL use 16-bit limbs:

```text
a0=a&0xffff; a1=a>>16; b0=b&0xffff; b1=b>>16
p0=a0*b0; p1=a0*b1; p2=a1*b0; p3=a1*b1
mid=(p0>>16)+(p1&0xffff)+(p2&0xffff)
lo=(p0&0xffff)|((mid&0xffff)<<16)
hi=p3+(p1>>16)+(p2>>16)+(mid>>16)
```

Convert a word to an open-interval uniform by

\[
U=(x+0.5)2^{-32}.
\]

### 13.7 Incumbent publication and display invariant

The discovery incumbent is internal search state. The application SHALL NOT display a resampled discovery path as the current trajectory.

After each complete 30-second optimization interval, the optimizer worker SHALL send a compact snapshot of the current binary64 discovery incumbent and at most one archive alternate. It SHALL then continue search without waiting. The main thread SHALL keep at most one active live-presentation job and one newest pending snapshot. A superseded pending snapshot SHALL be discarded.

The independent live-presentation worker SHALL apply, in order, the same publishable-product pipeline to every snapshot:

1. rebuild the discovery basis and trajectory in binary64;
2. fit the canonical curvature representation;
3. apply the bounded time-preserving smoothing rule;
4. project strict periodic closure;
5. evaluate the 1024-, 2048-, and 4096-edge meshes;
6. independently certify the 2048-, 4096-, and 8192-edge meshes and 16384-sample closure residual; and
7. build the displayed 4096-sample path and 8192-edge profile from the certified canonical representation.

Only a passing certified product MAY replace the displayed current trajectory, and only when its certified lap time is smaller. The optimizer worker has no message type that can publish a trajectory directly. OPTIMIZE SHALL remain disabled until the starting trajectory has a passing certificate.

The following WYSIWYG invariant is mandatory:

> At every instant during optimization, the displayed current trajectory is already a complete final product. If STOP is pressed at that instant, the stopped result SHALL retain the same trajectory representation, rendered path, profile, lap time, and certificate that were displayed immediately before STOP.

STOP SHALL invalidate and terminate every unpublished live-presentation job before it can update the display. STOP SHALL NOT convert, smooth, project, certify, or promote a newer hidden discovery candidate. If no live product has been published in the current run, the starting certified incumbent remains the stopped result.

Compare certified times with

\[
T'<T-\max(10^{-9}\ \mathrm s,32\epsilon T).
\]

Bitwise ties choose the smaller candidate ID. A failed certification is logged and never displayed as best.

### 13.8 Run lifetime

Optimization has no convergence stop, deadline, or duration option. Every run SHALL continue until STOP, a fatal device error, a track/settings change, or page shutdown. The worker `start` command SHALL contain no duration or deadline field. This makes an accidental time-limited run impossible at the protocol boundary. The UI SHALL state that the run continues until STOP and SHALL show elapsed time, batches, valid candidates, rejection causes, discovery time, certified displayed time, and certified improvement history.

## 14. WebGPU compute design

### 14.1 Capability contract

The optimizer SHALL request a high-performance adapter. It SHALL require only portable WebGPU limits:

```text
maxComputeInvocationsPerWorkgroup >= 256
maxComputeWorkgroupStorageSize >= 16384
maxStorageBuffersPerShaderStage >= 8
```

WGSL production mathematics uses `f32`, `u32`, and `i32`. It SHALL NOT assume shader `f64` or concrete 64-bit integers. Optional subgroups MAY accelerate reductions only when the result matches the portable reduction path.

### 14.2 Work decomposition

Use `@workgroup_size(256,1,1)`. One workgroup owns one chain proposal. A normal batch dispatches 1024 workgroups.

Within a workgroup:

1. invocation 0 generates the mutation and assembles patch metadata;
2. invocations 0–31 cooperatively form residuals, Jacobian column norms, and Householder dot products;
3. invocation 0 performs scalar QR decisions and triangular substitution;
4. all invocations compile one dynamic/containment microinterval each;
5. all invocations perform the Jacobi speed-envelope iteration with barriers;
6. all invocations reduce edge time and maximum residual in a fixed binary tree;
7. invocation 0 performs Metropolis acceptance and writes the chain state; and
8. invocation 0 appends a provisional-best record through an atomic compare/exchange protocol.

No workgroup reads another chain state during proposal evaluation. Replica exchange is a separate dispatch and therefore has a global synchronization boundary.

### 14.3 Workgroup storage budget

The shader SHALL remain below 16,384 bytes. The reference layout is:

| Array | Elements | Bytes |
|---|---:|---:|
| squared speed A | 256 `f32` | 1024 |
| squared speed B | 256 `f32` | 1024 |
| edge length | 256 `f32` | 1024 |
| curvature bound | 256 `f32` | 1024 |
| reduction scratch | 256 `f32` | 1024 |
| maximum local QR matrix | 24×14 `f32` | 1344 |
| QR vectors, residuals, permutations | fixed | <=1024 |
| patch controls and trial controls | fixed | <=1024 |
| containment scratch | fixed | <=2048 |

The total reference budget is at most 10,560 bytes. A shader change SHALL include a compile-time size calculation and remain below the adapter limit.

### 14.4 Storage-buffer records

All records use WGSL host-shareable alignment. `vec2<f32>` aligns to 8 bytes and `vec4<f32>` to 16 bytes. C99/TypeScript writers SHALL test every offset. C99 records SHALL use only fixed-width integer fields, `float`, and explicit padding arrays. Every record SHALL have a C99 `sizeof` test and a per-field `offsetof` test against this table.

`ChainState` consists of:

| Field | Type | Offset |
|---|---|---:|
| lap time, energy, sigma, temperature | `vec4<f32>` | 0 |
| chain ID, level, accepted count, stagnation | `vec4<u32>` | 16 |
| genotype offsets | `array<f32,64>` | 32 |
| complex preimage controls | `array<vec2<f32>,128>` | 288 |
| total byte size |  | 1312 |

`TrackGpuHeader` is exactly 128 bytes:

| Offset | Type | Contents |
|---:|---|---|
| 0 | `vec4<f32>` | world origin X/Y, scale \(H\), \(1/H\) |
| 16 | `vec4<f32>` | normalized \(L_e,W_e,L_v,W_v\) |
| 32 | `vec4<f32>` | \(v_{\max}^2,a_{x,+0},a_{x,-0},a_{y,0}\) |
| 48 | `vec4<f32>` | \(p,\delta,\gamma,\kappa_{\max}\); zero curvature means disabled |
| 64 | `vec4<u32>` | gate, span, microinterval, and cell counts |
| 80 | `vec4<u32>` | half-space, candidate-cell, gate, and span offsets |
| 96 | `vec4<u32>` | counter, best-record, rejection, and display offsets |
| 112 | `vec4<u32>` | run-version low/high and seed low/high |

Variable arrays live in separate storage buffers:

- 64 center gates and normals as `vec4<f32>`;
- corridor half-spaces as `vec4<f32>` containing `(nx,ny,b,unused)`;
- cell ranges and microinterval candidate-cell IDs as `u32`;
- immutable centerline/oracle metadata;
- global-best and counters; and
- rejection counters by code.

### 14.5 Rejection codes

The GPU SHALL count these mutually exclusive first-failure codes:

```text
0 valid
1 nonfinite_input
2 projection_rank_failure
3 projection_no_descent
4 interpolation_residual
5 irregular_preimage
6 nonpositive_length
7 racing_line_self_intersection
8 rectangle_outside_corridor
9 curvature_limit
10 speed_envelope_no_convergence
11 dynamic_infeasible
12 nonfinite_lap_time
```

The diagnostics panel SHALL report counts and percentages.

### 14.6 Batch latency and STOP

The optimizer worker SHALL tune proposals per dispatch to keep measured batch wall time between 20 and 50 ms. It starts with one proposal per chain. If one dispatch exceeds 50 ms, split the chain range across multiple dispatches. STOP freezes the displayed product, terminates unpublished presentation work, sets an atomic worker flag, submits no further batch, waits only for the in-flight dispatch, and writes the resumable checkpoint. It performs no post-search finalization.

Each live-presentation job SHALL report monotonic progress over three bounded finalization stages and seven independent certification stages. Stage count is deterministic; elapsed time per stage is not assumed to be uniform because closure projection can require a variable number of Newton iterations. This work runs concurrently with optimization and SHALL NOT block optimizer dispatches.

### 14.7 Device loss

On `GPUDevice.lost`, stop the run, preserve the last certified best, discard provisional GPU states, show the loss reason, and offer a WebGPU restart or CPU fallback. Device loss SHALL NOT corrupt saved profiles.

## 15. Rendering and visualization

### 15.1 Track renderer

The main thread SHALL render with WebGPU. Canvas 2D is the fallback. Rendering is not part of geometric certification.

The viewport SHALL show, in this order:

1. background and grid;
2. track lane fill;
3. exact-offset boundary tessellations;
4. start/finish stripe;
5. translucent in-progress candidate lines, at most 64;
6. certified best line as a solid high-contrast line;
7. selected saved racing lines as dashed lines;
8. animated physical vehicle rectangles; and
9. labels and lap order.

The renderer SHALL evaluate PH lines analytically into a GPU vertex buffer. It SHALL adapt screen tessellation until the midpoint-to-chord deviation is below 0.35 CSS pixels. The last vertex equals the first without a visible seam.

### 15.2 Camera

The camera has two modes: `Fit all` and `Zoomed`. `Zoomed` defaults off on each page load. The camera SHALL preserve aspect ratio and SHALL NOT rotate automatically.

In `Fit all`, the camera SHALL fit the complete outer boundary with 8 CSS pixels of requested horizontal padding and 8% requested vertical padding. If the opposite axis limits scale, the resulting unused space MAY be larger. Track selection resets the camera to `Fit all`. Starting PLAY uses the current `Zoomed` toggle value; it SHALL NOT silently change that value.

In `Zoomed`, the camera follows one focused vehicle and centers its physical rectangle in the track viewer on every animation frame. Let the viewer's content-box dimensions in CSS pixels be \(W_c,H_c\). Let \(T=(T_x,T_y)\) be the focused vehicle's unit tangent and \(N=(-T_y,T_x)\). With a nonrotating camera, the physical \(L_v\times W_v\) rectangle has axis-aligned world extents

\[
B_x=L_v|T_x|+W_v|N_x|,
\qquad
B_y=L_v|T_y|+W_v|N_y|.
\]

The required camera scale in CSS pixels per meter is

\[
\alpha=\min\left(\frac{W_c}{5B_x},\frac{H_c}{5B_y}\right).
\]

Thus the vehicle's screen-space bounding box occupies exactly one fifth of the limiting viewer dimension and no more than one fifth of the other dimension. Device pixel ratio SHALL NOT enter this calculation. The renderer applies device pixel ratio only after computing the CSS-pixel camera transform.

The zoomed camera center and scale SHALL update from the analytic Section 12.9 position and tangent in the same animation frame. There is no smoothing, scale clamp, look-ahead offset, or camera rotation, because any of those could violate the exact one-fifth rule. Toggling `Zoomed`, changing focus, resizing the viewer, or changing device-pixel ratio recomputes the transform on the next rendered frame.

The default focused racer is the current unsaved certified profile when it participates. Otherwise it is the first checked compatible saved profile in visible list order. Clicking a vehicle, racing line, saved-profile playback row, or race-order row makes that participant the focus without changing race time. Focus remains fixed until the user selects another racer or removes the focused racer. Removal selects the default by the same rule. If no racer is available, `Zoomed` is disabled and the camera remains `Fit all`.

At the default fit-all view and default vehicle dimensions, every catalog track SHALL render the vehicle at no less than 10 CSS pixels long and 4 CSS pixels wide on a 1200×600 track canvas. The renderer SHALL NOT enlarge only the vehicle. Catalog geometry is deliberately minified and thick enough to meet this physical-scale rule.

### 15.3 Line colors

Use deterministic colors:

| Item | Color |
|---|---|
| certified current best | `#ff8a1f` |
| provisional GPU best | `#ffd19a` dashed |
| active candidates | `rgba(79,195,247,0.16)` |
| left boundary | `#f1f3f5` |
| right boundary | `#c8cdd2` |
| centerline when no result | `#58616b` |
| invalid/uncertified flash | `#ef5350` |

Saved profile and vehicle colors come from a fixed color-blind-safe palette keyed by profile UUID.

### 15.4 Vehicle drawing

The drawn rectangle SHALL have physical dimensions \(L_v\times W_v\), excluding the invisible safety margin. Its center is the racing-line point and its long axis is \(T\). A small front marker SHALL distinguish direction. The optional safety envelope MAY be drawn as a translucent \(L_e\times W_e\) rectangle.

## 16. User interface

### 16.1 Desktop layout

The primary layout targets a 1440×900 desktop and remains functional down to 1024×700.

```text
+----------------------+-----------------------------------------------+
| TRACK CATALOG        | TRACK VIEW                                    |
|                      | candidates, best line, vehicles                |
| [track cards]        |                                               |
|                      +----------------------+------------------------+
| SAVED PROFILES       | VEHICLE / DYNAMICS   | TIME PROFILE           |
| [checkbox list]      | settings             | multi-axis plot        |
|                      |                       |                        |
|                      +----------------------+------------------------+
|                      | OPTIMIZE STOP PLAY SAVE + status               |
+----------------------+-----------------------------------------------+
```

The left rail is 280 CSS pixels. The track view receives 52–60% of available right-side height. Settings and profile share the lower area. The configuration column SHALL be at least 430 CSS pixels while settings use a compact two-column row. Each 10 CSS pixel label SHALL read `setting name — description`, span the complete row above its value editor, and remain on one line with end ellipsis only when the row is too narrow. The equation SHALL start immediately after the fixed-width value editor and align vertically with its field, so no separate description column or reserved empty band runs through the settings list. Above that minimum, extra width SHALL favor the track view. Below 1150 CSS pixels, each setting SHALL reflow to one column, so the configuration column can contract without horizontal overflow. A settings region SHALL never show a horizontal scrollbar. Mobile is not a version-1 target.

### 16.2 Track catalog

Each card displays a generated thumbnail, fictional name, layout tags, lap length, lane width, and saved-profile count. Clicking a card selects it. Changing track while a run or unsaved certified result exists SHALL request confirmation.

An `Import track` control opens a local file picker for `.optrack.json`. Imported data is compiled and certified in the certifier worker before it appears in the catalog. No file is uploaded.

The left rail has two headings:

- **TRACK CATALOG** for built-in and imported tracks;
- **SAVED PROFILES** for the selected track.

Saved profiles use checkboxes for race playback and a separate row click for inspection. A row action `Use as optimization seed` selects at most one compatible profile without changing playback checkboxes. The list shows name, lap time, vehicle size, creation time, and compatibility state.

The saved-profile menu provides Rename, Export, and Delete. The section header provides `Import profile`. Delete requires confirmation and removes only the selected IndexedDB record. Export and import use `.opprofile.json` and the verification rules in Section 20.3.

### 16.3 Settings

Settings are grouped as:

1. **Vehicle body:** length, width, safety margin, mass.
2. **Speed and tire limits:** maximum speed, traction acceleration, braking acceleration, lateral acceleration, ellipse exponent, optional curvature limit.
3. **Aerodynamics:** drag area, downforce area, air density.
4. **Optimizer:** 64-bit seed, deterministic mode, candidate-visibility count.

Every numeric control SHALL have a range input and direct numeric input. The numeric input is authoritative. Units are visible beside the value. Speed entry supports a km/h display toggle but stores m/s.

Changing geometry or dynamics marks the current result `settings changed`. It remains inspectable but cannot be SAVED as the current result or PLAYED as current until re-certified under the new settings. Previously saved profiles keep their own settings and remain playable.

### 16.4 Buttons

The control order is:

```text
[ OPTIMIZE / STOP — full control-column width ] [ PLAY / PAUSE ] [ SAVE ] [ ] Zoomed [ Focus: racer ]
[ Configuration                                        RESET ]
[ vertically scrolling settings                              ]
```

OPTIMIZE SHALL be orange and use a larger label than secondary controls. Button behavior is:

- **OPTIMIZE:** starts a new population from the current certified genotype, or the centerline if none exists. It always runs until STOP. After STOP, it resumes the in-memory/checkpointed chains when track and settings fingerprints match.
- **STOP:** replaces OPTIMIZE in the same full-width position while a run is active. It SHALL blink to make the manual-stop requirement visible. It freezes the displayed certified product, cancels unpublished presentation work, atomically requests the bounded stop in Section 14.6, and preserves a resumable checkpoint. It does not change the displayed trajectory.
- **RESET:** restores default vehicle settings and run mode, clears the elapsed optimization time to `—`, and starts baseline recertification.
- **PLAY:** resets all selected racers to the common start and starts animation. During playback its label is PAUSE. It is disabled while optimizing or stopping.
- **SAVE:** stores the current certified profile. It is disabled without a certified current profile or when settings have changed.
- **Zoomed:** a toggle that may be changed before PLAY, while playing, or while paused. When active it applies the camera and focus rules in Section 15.2. It is disabled only when there is no playable participant.
- **Focus:** identifies the racer followed by `Zoomed`. The select control lists all playback participants by profile color and name. Direct selection in the viewer or race-order list SHALL synchronize this control.

A small `New run` command discards the checkpoint after confirmation and seeds all chains from the current certified line or centerline.

While optimization is active, the header status SHALL remain steady. STOP SHALL be the only blinking control or notification. Validation progress remains deterministic and does not blink.

### 16.5 Status

Status SHALL distinguish:

```text
READY
OPTIMIZING
STOPPING
CERTIFYING
READY — CERTIFIED BEST
PLAYING
PAUSED
GPU LOST
ERROR
```

During optimization show elapsed time, batch count, the cumulative number of candidates evaluated, valid percentage, most frequent rejection, discovery time, displayed certified time, and last certified improvement time. The viewer metric strip SHALL show `CANDIDATES` as a cumulative count and SHALL NOT show proxy/s, full-laps/s, or certified/s rates. No configurations/s target or success color is attached to throughput.

## 17. Time-profile plot

### 17.1 Shared plot and axes

The plot uses one shared time X-axis in seconds and one shared plotting rectangle. It overlays all series but provides a separate colored Y-axis and unit for each quantity:

| Series | Color | Axis | Unit |
|---|---|---|---|
| speed | `#ff8a1f` | left 1 | km/h |
| net longitudinal acceleration | `#26c6da` | right 1 | m/s² |
| signed lateral acceleration | `#ec407a` | right 2 | m/s² |
| stability utilization \(U\) | `#66bb6a`, red above 1 | right 3 | ratio |
| signed curvature | `#ab8cff` | left 2 | 1/m |

Every axis title, ticks, and series use the same color. The chart SHALL NOT imply that different units share one numeric scale.

### 17.2 Interaction

The chart SHALL support pointer hover, keyboard cursor movement, horizontal zoom, and reset. The synchronized tooltip shows time, distance, speed, tangential acceleration, lateral acceleration, utilization, curvature, and line position.

Dragging the derived speed curve is forbidden. The chart is a profile inspector. Users edit constraints through settings, after which the optimizer recomputes the maximal periodic profile.

When saved comparisons are selected, their series use the saved-profile color and lower opacity. The current profile keeps the base series colors. A legend can isolate one profile.

### 17.3 Stability display

Draw a horizontal stability limit at \(U=1\). Color the utilization line green for \(U\le0.95\), amber for \(0.95<U\le1\), and red for \(U>1\). A certified profile SHALL never contain red; red is allowed only for imported invalid data or a provisional diagnostic.

## 18. Multi-profile race playback

### 18.1 Participants

PLAY includes:

- every checked saved profile for the selected track; and
- the current unsaved certified profile, when one exists.

Duplicate profile UUIDs are included once. Profiles from another track fingerprint are disabled.

### 18.2 Common start and looping

On PLAY, set the race clock to zero and place every vehicle center at its own racing line's start-gate intersection. For racer \(j\) with lap time \(T_j\), use

\[
\tau_j(t)=t\bmod T_j.
\]

Each vehicle therefore loops at its own period. Faster profiles naturally gain laps. PLAY or the `Restart` command resets all racers to the common start again. PAUSE freezes the shared wall clock.

### 18.3 Race order

Track each racer by common topological phase. If the current compiled PH location is span \(j\) with local parameter \(\nu\), define

\[
u_j(t)=\frac{j+\nu}{128},
\qquad
P_j(t)=\left\lfloor t/T_j\right\rfloor+u_j(t).
\]

All racing lines share the same ordered gate/span topology, so this phase preserves track order even when line lengths differ. Sort descending by \(P_j\), then profile UUID for ties. To display a time gap at phase \(u\), interpolate each profile's cumulative time at the same span and local PH parameter and subtract it from the leader's race time. Display completed laps, time gap, and current lap time. There is no drafting, blocking, collision, or start reaction model.

### 18.4 Animation clock

Use `requestAnimationFrame` and `performance.now()`. Provide 0.25×, 0.5×, 1×, 2×, and 4× playback. Animation time derives from accumulated real delta multiplied by playback speed; it SHALL NOT derive from frame count. Respect `prefers-reduced-motion` by defaulting to 0.5× and `Zoomed` off. An explicit user change to `Zoomed` overrides that default. Zoomed camera updates remain unsmoothed.

## 19. Fictional caricature track catalog

### 19.1 Catalog rule

Built-in layouts SHALL be visibly stylized caricatures with invented names. They MAY evoke common Grand Prix motifs such as a long straight, hairpin, linked esses, or a stadium section, but SHALL NOT copy surveyed coordinates, official names, logos, branding, or exact scale.

Each track SHALL:

- contain exactly 64 center gates;
- have a 450–900 m centerline lap;
- fit within a 180–320 m largest dimension;
- use constant left/right half-widths between 7 and 12 m;
- have at least one left turn, one right turn, one heavy-braking corner, and one fast section;
- remain planar and non-self-intersecting;
- fit the default effective vehicle rectangle; and
- pass every track compiler certificate.

### 19.2 Initial tracks

The initial catalog SHALL contain at least these eight original mock layouts:

| ID | Name | Layout character |
|---|---|---|
| `ember-ring` | Ember Ring | long straight, tight opening switch, two broad return bends |
| `harbor-thread` | Harbor Thread | compact street-like chain of right angles and two hairpins |
| `alpine-comet` | Alpine Comet | fast descending-shape sweeps, compressed hairpin, long return arc |
| `sakura-coil` | Sakura Coil | alternating esses and a terminal hairpin without a crossover |
| `silver-prairie` | Silver Prairie | high-speed linked corners and one short technical complex |
| `desert-crown` | Desert Crown | three straights joined by slow hooks and a wide final turn |
| `atlantic-key` | Atlantic Key | stop-start key-shaped outline with a flowing back section |
| `iberian-kite` | Iberian Kite | mixed-radius corners, short chute, and a broad stadium loop |

Coordinates SHALL be authored specifically for this application, compiled from PH gates, and reviewed side by side to ensure no track is an exact trace of a real circuit.

## 20. Data contracts

### 20.1 Track source JSON

Files use extension `.optrack.json` and this structure:

```json
{
  "schemaVersion": 1,
  "id": "ember-ring",
  "name": "Ember Ring",
  "description": "...",
  "direction": "counterclockwise",
  "centerGatesM": [[0.0, 0.0]],
  "leftWidthM": 9.0,
  "rightWidthM": 9.0,
  "startGate": 0,
  "tags": ["fast", "hairpin"],
  "sourceVersion": 1
}
```

`centerGatesM` SHALL contain exactly 64 finite pairs and no repeated closing point. Unknown fields are rejected in source/compiler validation.

### 20.2 Compiled track asset

Compiled assets remain JSON for auditability and contain:

- the complete source record;
- source SHA-256;
- normalization \(O,H\);
- binary64 centerline preimage controls and span coefficients;
- exact left/right rational offset controls and weights;
- length and curvature certificates;
- convex corridor vertices and normalized half-spaces;
- 256 microinterval candidate-cell lists;
- render tessellation seeds; and
- compiler version and certificate report.

All numeric arrays have fixed expected lengths recorded in `schemas/compiled-track.schema.json`. A loaded asset is rejected if recomputed SHA-256 or a certificate summary differs.

### 20.3 Saved profile

A saved `.opprofile.json` contains:

```text
schemaVersion
profileId                 UUID v4
name
createdAt                 ISO-8601 UTC
trackId
trackFingerprint          SHA-256
vehicleSettings
dynamicSettings
optimizerSeed             two u32 values
genotypeD                 64 binary64 values
preimageControls          128 complex binary64 pairs
lineLengthM
lapTimeS
profileNodes[]            parameter, distance, time, q, acceleration,
                          curvature, stability
certificate               tolerances, depths, code version, hash
```

Import SHALL ignore stored claims until C99/WASM recomputes all certificates. A successful import may then store a canonical reserialized version.

### 20.4 IndexedDB

Database name is `optiline`, version 1. Object stores are:

| Store | Key | Purpose |
|---|---|---|
| `tracks` | track fingerprint | imported compiled tracks |
| `profiles` | profile UUID | certified saved profiles |
| `runCheckpoints` | track+settings fingerprint | resumable GPU chain snapshot |
| `preferences` | string | UI and playback preferences |

SAVE is one transaction that writes the profile and updates track metadata. A failed transaction leaves no partial profile.

The database is shared by every application instance on the same browser profile and exact site origin. A new instance SHALL load all compatible saved profiles and imported tracks from it. After SAVE, the application SHALL request persistent browser storage when that API is available. Different origins, ports, browser profiles, and devices do not share IndexedDB; cross-device sharing requires explicit export/import or a future server-side synchronization service.

The default saved name is `<track name> — <lap time to 0.001 s> — <local date/time>`. The user may edit it before commit. Empty names and names longer than 120 Unicode scalar values are rejected.

### 20.5 Fingerprints

Canonical JSON uses UTF-8, sorted object keys, no insignificant whitespace, decimal numbers serialized by the ECMAScript shortest round-tripping representation, and arrays in stored order. Hash with Web Crypto SHA-256. Native C99 tests SHALL produce identical canonical bytes and hashes from parsed numeric records.

## 21. Application state machine

| State | Allowed actions | Exit condition |
|---|---|---|
| `loading` | none | assets and workers ready |
| `ready` | select, edit, optimize, play if profile, save if certified, toggle zoom/focus if profile | action |
| `optimizing` | stop, inspect | STOP or error |
| `stopping` | inspect | in-flight GPU batch ends and checkpoint is returned |
| `certifying` | inspect | certificate pass/fail |
| `playing` | pause, restart, speed change, toggle zoom, change focus | pause or track change |
| `paused` | play, restart, select profiles, toggle zoom, change focus | action |
| `gpuLost` | restart GPU, CPU fallback | selection |
| `error` | reset, export diagnostics | recovery |

Every asynchronous message contains track fingerprint, settings fingerprint, and monotonically increasing run version. The receiver SHALL discard stale messages.

## 22. CPU fallback

When WebGPU is unavailable or lost, C99/WASM SHALL run the same genotype, PH construction, containment, speed, and replica-exchange rules. With cross-origin isolation it MAY use a worker pool of

\[
\min(\max(1,\texttt{hardwareConcurrency}-1),16)
\]

workers. Every worker SHALL instantiate its own single-threaded `optiline_certifier.wasm` with private memory. No WASI thread or `pthread` API is used. Without isolation the application uses one worker. The CPU fallback may reduce replica count, but SHALL keep all formulas and certification rules. It SHALL label results `CPU search` and remains eligible for SAVE after binary64 certification.

## 23. Numerical and error policy

### 23.1 General rules

- Reject NaN and infinity at every public input and shader output boundary.
- Use scaled `hypot` for vector norms in C99.
- Use fused multiply-add where available, but do not require identical CPU/GPU last bits.
- Use de Casteljau for authoritative Bernstein evaluation.
- Use Neumaier summation for lengths and times.
- Never normalize a vector until regularity provides a positive lower bound.
- Never clamp a materially negative length, speed, weight, or discriminant to zero.
- A GPU ambiguity is rejection or binary64 escalation, never acceptance.

### 23.2 Deterministic mode

Deterministic mode fixes seed, dispatch chain ordering, reductions, pivot ties, candidate IDs, and serialization. It guarantees repeatability on the same Chrome, adapter, driver, and build. Cross-GPU bit identity is not required. Certified binary64 results from the same genotype SHALL agree within the stated tolerances.

### 23.3 Certification record

Every certified profile stores:

- maximum interpolation residual;
- minimum preimage-speed bound;
- maximum seam tangent and curvature residual;
- minimum containment half-space bound;
- maximum dynamic utilization upper bound;
- speed fixed-point residual;
- adaptive edge count;
- lap-time convergence delta;
- source and build fingerprints; and
- pass/fail code.

## 24. Testing specification

### 24.1 C99 mathematical tests

Tests SHALL cover:

- explicit quadratic product coefficients against symbolic expansion;
- exact displacement Gram matrix against high-precision integration;
- position derivative equals \(hw^2\);
- speed equals \(h|w|^2\);
- arc polynomial derivative equals speed;
- tangent unit length;
- analytic curvature against high-precision automatic differentiation;
- exact rational offset identity;
- offset length identity \(L_d=L-2\pi n_Td\);
- forward/reverse playback inverse-length residual in the playback target;
- antiperiodic preimage and periodic physical seam; and
- regularity certificates around near-zero preimages;
- a loop confined inside one corridor cell is rejected; and
- nonadjacent and same-span self-intersections are isolated.

The test build SHALL inspect the `optiline_certifier` native link map and the `optiline_certifier.wasm` export/name sections. Either artifact containing `op_arc_length_inverse`, `op_point_at_distance`, or `op_playback_inverse` is a test failure. Conversely, the playback target SHALL contain those functions and SHALL NOT export track compilation, optimizer, containment-certificate, or dynamic-certificate entry points.

### 24.2 C99 toolchain and ABI tests

Every commit SHALL build and run the same C test sources with:

1. MSVC 19.44 or the pinned newer patch using `/TC /std:c17`; and
2. WASI SDK 33.0 Clang using `--target=wasm32-wasip1 -std=c99 -pedantic-errors`.

The test SHALL verify `sizeof(float)==4`, `sizeof(double)==8`, `CHAR_BIT==8`, IEEE-754 binary32/binary64 characteristics through `FLT_RADIX`, `FLT_MANT_DIG`, and `DBL_MANT_DIG`, little-endian ABI order, every public structure size, every `offsetof`, exported function signatures, and all error-code integer values. Unsupported platforms fail configuration. At least 100,000 identical fixture calls SHALL compare native MSVC and browser-WASM binary64 results under the Section 24.3 tolerance policy.

### 24.3 Python oracle fixtures

Generate and check in at least 10,000 deterministic cases from `C:\repos\ph-splines`, including convex, nonconvex, near-straight, high-scale, low-scale, closed, offset, and inverse-length cases. Each fixture records source controls, points, tangents, normals, curvature, length, inverse samples, and offset samples.

C99 binary64 tolerances are:

\[
|x_{\mathrm{c99}}-x_{\mathrm{oracle}}|
\le 256\epsilon\max(1,|x_{\mathrm{oracle}}|)
\]

for elementary evaluated values, or the stronger residual tests specified in the relevant sections.

### 24.4 WGSL conformance

For at least one million seeded normalized spans, compare WGSL outputs read back from Chrome with C99 f32 reference outputs. Require:

- no false feasible regularity result;
- no false feasible containment result;
- no false dynamic-feasible result after GPU margins;
- relative length error below \(2\times10^{-5}\);
- curvature bound never below the sampled high-precision maximum; and
- deterministic candidate ordering on repeated runs.

False rejection is permitted and measured. False acceptance is a release blocker.

Shader source and dispatch instrumentation SHALL prove that a candidate evaluation makes zero calls or iterations for numerical quadrature, inverse arc length, closest-point solution, and finite-difference frame construction. A nonzero counter is a release blocker.

### 24.5 Containment tests

Mandatory cases include:

- rectangle centered in a straight corridor;
- front corner touching an outer boundary;
- rear corner touching an inner boundary;
- centerline feasible while the long rectangle exits a hairpin;
- legal rectangle that a half-diagonal disk would falsely reject;
- seam-crossing sweep;
- corner tangency with no crossing;
- a violation confined between all search samples;
- intervals requiring 1, 8, 20, and 40 subdivisions;
- corridor cell near a lane concavity; and
- invalid cell intersecting or enclosing a boundary component.

Every accepted case SHALL return the sequence of cells and parameter intervals that forms the proof in Section 10.7.

### 24.6 Dynamic tests

Mandatory cases include:

1. **Constant-radius circle, no drag/downforce:** constant speed equals \(\sqrt{a_{y,0}/|\kappa|}\) when below \(v_{\max}\).
2. **Straight, no drag:** forward and braking equations reduce to \(q_1=q_0+2a\Delta s\).
3. **Straight with drag:** constant-speed tire demand equals \(\delta q\).
4. **Downforce:** \(\Lambda(q)\) and lateral capacity increase monotonically with \(q\).
5. **Ellipse:** every accepted edge has \(U\le1\) under interval evaluation.
6. **Asymmetric braking:** increasing \(a_{x,-0}\) cannot increase certified lap time for fixed geometry.
7. **Periodic seam:** rotating the node index leaves lap time unchanged within tolerance.
8. **Grid refinement:** certified lap time converges within 1 microsecond.

### 24.7 Optimizer tests

- Philox known-answer vectors on C99, TypeScript, and WGSL.
- Reflection never leaves the gate range and has no clamped point mass.
- Metropolis and swap decisions match a scalar reference.
- Strict-local edits leave exterior controls bitwise unchanged.
- Failed edits are atomic.
- Fixed seed repeats on the same device/build.
- The certified-best lap time never increases during a run.
- Every SAVE payload rebuilds from genotype and passes independently.

### 24.8 UI and end-to-end tests

Run Playwright against stable Chrome on Windows 11. Cover track selection, input validation, optimize/stop/resume, device-loss simulation, save/import/export, stale-worker messages, plot axes and units, common PLAY start, independent looping, race order, reduced motion, keyboard operation, and IndexedDB migration.

Zoom tests SHALL toggle before PLAY, during PLAY, and while paused; change the focused racer from every supported selection surface; remove the focused racer; and resize the viewer. At tangents of 0°, 30°, 45°, 90°, and 137°, measure the rendered physical rectangle's CSS-pixel bounding box. One of its width/viewer-width or height/viewer-height ratios SHALL equal 0.2 within 0.5 CSS pixels, and neither ratio may exceed 0.2 by more than 0.5 CSS pixels. Repeat at device-pixel ratios 1, 1.25, 1.5, and 2.

### 24.9 Visual regression

Capture 1440×900 and 1024×700 screenshots for every app state and each catalog track. Capture `Fit all` and `Zoomed` PLAY views with one and four racers. Verify that the default vehicle meets the minimum pixel-size rule, the focused vehicle meets the one-fifth rule, axes do not overlap the plot, and long fictional track names do not truncate essential controls.

## 25. Performance measurement

Performance is diagnostic, not a release target. Report on Windows 11, stable Chrome, and the adapter/driver shown by the browser.

Measure after shader compilation and five warm-up batches:

1. PH local projections/s;
2. full 256-edge candidate evaluations/s;
3. percentage and causes of rejection;
4. optimizer batch median, p95, and worst latency;
5. binary64 incumbent certification median and p95;
6. render frame time during 64-candidate display; and
7. memory use per chain and total GPU buffers;
8. counts of numerical quadrature, inverse-length, closest-point, and finite-difference operations in the candidate hot path, all required to be zero; and
9. playback-only inverse calls and their median and p95 time, reported separately from optimization.

Use a 30-second seeded run on every built-in track. Do not combine raw projection throughput with complete candidate throughput.

For the PH demonstration report, run a separate ordinary-representation length microbenchmark on the same degree-5 Bézier position controls. Discard the PH preimage and evaluate

\[
f(\nu)=\left|5\sum_{i=0}^{4}(p_{i+1}-p_i)B_i^4(\nu)\right|.
\]

For each even \(N\in\{32,64,128,256\}\), approximate one span length by composite Simpson quadrature

\[
L_N=\frac{1}{3N}\left[f(0)+f(1)
+4\sum_{\substack{j=1\\j\ \mathrm{odd}}}^{N-1}f(j/N)
+2\sum_{\substack{j=2\\j\ \mathrm{even}}}^{N-2}f(j/N)\right].
\]

Report throughput and absolute/relative error against the exact PH length for at least one million seeded spans. Compare that with evaluation of the PH degree-5 arc polynomial. This isolates the exact-length benefit but SHALL be labeled a microbenchmark, not proof that all ordinary-spline optimizers have this cost.

## 26. Accessibility and input safety

All controls SHALL have labels, keyboard focus, visible focus rings, and programmatic error text. Color SHALL NOT be the sole status signal. Buttons SHALL meet WCAG AA contrast. Plot series have dash/marker differences in addition to color. Numeric parsing SHALL reject locale-ambiguous or nonfinite values rather than guess.

Imported JSON SHALL have a 20 MiB size limit, maximum nesting depth 16, exact schema validation, and bounded arrays. Error messages SHALL identify the field and rule without displaying raw untrusted HTML.

## 27. Implementation sequence

### Phase 1 — Mathematical core

Implement C99 complex primitives, Bernstein operations, PH spans, exact forward arc length, offsets, regularity, global construction, and local edits. Put playback-only inverse length in its separate translation unit. Build and test the same core with MSVC and WASI SDK Clang. Verify both against Python fixtures.

### Phase 2 — Track compiler and catalog

Implement exact offsets, self-intersection checks, corridor-cell generation and validation, eight fictional source tracks, compiled assets, and schemas.

### Phase 3 — Vehicle and dynamics

Implement swept-rectangle certificate, aerodynamic ellipse, cyclic speed envelope, adaptive incumbent profile, and analytic tests.

### Phase 4 — Web application shell

Implement native UI, workers, renderer, plots, state machine, IndexedDB, import/export, and playback with C99/WASM certification only.

### Phase 5 — WebGPU optimizer

Port conservative f32 kernels to WGSL, add replica-exchange search, cross-language conformance, diagnostics, STOP latency control, and device-loss recovery.

### Phase 6 — Hardening

Run fuzzing, one-million-span WGSL tests, Chrome end-to-end tests, visual regression, long optimization runs, memory profiling, and static deployment checks.

No later phase may weaken an earlier certificate to improve speed.

## 28. Release acceptance checklist

- [ ] All eight catalog tracks compile with exact offsets and valid corridor cells.
- [ ] Default centerline and rectangle are feasible on every track.
- [ ] C99 core passes native MSVC, WASI/WASM, unit, property, oracle, and fuzz tests.
- [ ] WGSL has no false acceptance in the required conformance corpus.
- [ ] Published and saved profiles contain complete binary64 certificates.
- [ ] Vehicle length and width visibly and mathematically affect feasibility.
- [ ] Downforce increases tire capacity and drag consumes traction as specified.
- [ ] Lap time is the only optimization score.
- [ ] OPTIMIZE, STOP, PLAY, and SAVE pass state tests.
- [ ] Selected saved profiles and current profile start together and loop.
- [ ] `Zoomed` can change at any playback moment, follows the selected racer, and passes the exact one-fifth screen-size tests.
- [ ] Plot uses a common time axis and colored unit-specific Y-axes.
- [ ] Optimizer and all validators link no inverse-length code and execute no quadrature or inverse-length step.
- [ ] STOP p95 response after click is below 100 ms with normal batch tuning.
- [ ] Static production build runs in stable Chrome on Windows 11.
- [ ] No implementation equation lacks a corresponding equation or algorithm here.

## Appendix A. Cubic PH inverse-length reference

This appendix documents the cubic feature mentioned in the project premise. Version 1 does not use cubic PH for racing lines because of its fixed curvature-sign limitation.

For a cubic PH span,

\[
w(t)=a+bt,
\qquad
A=|b|^2,
\qquad
B=2\operatorname{Re}(\overline ab),
\qquad
C=|a|^2.
\]

Speed and arc length are

\[
\sigma(t)=At^2+Bt+C,
\]

\[
S(t)=\frac A3t^3+\frac B2t^2+Ct.
\]

For \(A>0\), define

\[
h=\frac{\operatorname{Re}(\overline ab)}A,
\qquad
g=\frac{|\operatorname{Im}(\overline ab)|}A,
\]

and for target length \(s\),

\[
R=h^3+3g^2h+\frac{3s}{A}.
\]

The unique real solution of

\[
y^3+3g^2y=R
\]

is

\[
y=2g\sinh\left[\frac13\operatorname{asinh}\left(\frac{R}{2g^3}\right)\right]
\]

when \(g>0\), and \(y=\operatorname{cbrt}(R)\) when \(g=0\). Recover without cancellation near the start by

\[
t=\frac{3s/A}{y^2+yh+h^2+3g^2}.
\]

If \(A=0\), use \(t=s/C\). Near the right endpoint, reverse the preimage and invert \(L-s\). Follow with bracketed Newton against the exact cubic and use the same residual tolerance as Section 8.8.

## Appendix B. Rational-boundary winding and intersection rules

### B.1 Point classification

To classify point \(p=(p_x,p_y)\) against one simple rational boundary, isolate every root of

\[
Y(u)-p_yW(u)=0
\]

with the Bernstein procedure in Section 7.4. Use a half-open parameter convention: include a root at a span's left endpoint and exclude it at the right endpoint, except the final periodic seam is excluded. At each root interval, certify whether

\[
X(u)-p_xW(u)>0.
\]

If not, it does not cross the rightward ray. An upward crossing adds 1 and a downward crossing subtracts 1, where direction comes from the interval sign of \(d(Y/W)/du\). Tangencies with no sign change add zero. Subdivide unresolved multiple roots and use derivative-root isolation through the first nonzero derivative.

A point is in the lane when it is inside the outer boundary and outside the inner boundary. Determine which exact offset is outer by absolute signed area, not by an assumed traversal direction. Boundary contact is inside.

### B.2 Rational span self-intersection

For two homogeneous rational spans \((X_1,Y_1,W_1)\) and \((X_2,Y_2,W_2)\), intersections solve

\[
F_x(u,v)=X_1(u)W_2(v)-X_2(v)W_1(u)=0,
\]

\[
F_y(u,v)=Y_1(u)W_2(v)-Y_2(v)W_1(u)=0.
\]

Represent both as bivariate Bernstein polynomials. Recursively subdivide the larger parameter dimension. Reject a box when either polynomial's coefficient hull excludes zero. On a remaining box, apply interval Newton to the 2×2 Jacobian. Isolate to width \(2^{-48}\). Any root between nonadjacent spans is a self-intersection. Adjacent spans may share only their common endpoint; any other root is invalid. Apply the same test between left and right boundaries, where no roots are allowed.

## Appendix C. Error and diagnostic types

C99 and worker messages SHALL use these stable codes:

```text
INVALID_INPUT
TRACK_CONSTRUCTION_FAILED
TRACK_OFFSET_CUSP
TRACK_BOUNDARY_INTERSECTION
CORRIDOR_CERTIFICATE_FAILED
PH_PROJECTION_FAILED
PH_RANK_DEFICIENT
PH_IRREGULAR
PH_INTERPOLATION_RESIDUAL
PH_SELF_INTERSECTION
PLAYBACK_ARC_LENGTH_INVERSION_FAILED
RECTANGLE_NOT_CONTAINED
DYNAMIC_PROFILE_FAILED
DYNAMIC_REFINEMENT_LIMIT
GPU_UNAVAILABLE
GPU_DEVICE_LOST
GPU_CERTIFICATION_MISMATCH
PROFILE_INCOMPATIBLE
PERSISTENCE_FAILED
STALE_MESSAGE
```

Every error contains `code`, `message`, `runVersion`, and structured numeric fields. Errors SHALL NOT be identified by parsing message text.

## 29. References

Normative mathematical references available locally:

1. `C:\repos\ph-splines\PHBSpline_Technical_Specification.md`
2. `C:\repos\ph-splines\CubicPHSpline_Technical_Specification.md`
3. `C:\repos\ph-splines\OffsetNURBS_Distance_Specification.md`
4. `C:\repos\ph-splines\ph_spline\` and its test suite

Web platform references:

1. W3C WebGPU: <https://www.w3.org/TR/webgpu/>
2. WebGPU Shading Language: <https://gpuweb.github.io/gpuweb/wgsl/>
3. Chrome WebGPU overview: <https://developer.chrome.com/docs/web-platform/webgpu/overview>
4. MSVC C language-standard modes: <https://learn.microsoft.com/en-us/cpp/build/reference/std-specify-language-standard-version?view=msvc-170>
5. WASI SDK 33 release: <https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-33>
6. WASI SDK build and CMake guidance: <https://github.com/WebAssembly/wasi-sdk>
