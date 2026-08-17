# GPU Minimum-Lap-Time Racing-Line Optimizer  
## Technical Specification — Version 1.0

**Target hardware:** NVIDIA GeForce RTX 4080  
**Track model:** closed planar Pythagorean-hodograph centerline with left/right offset boundaries  
**Vehicle model:** rectangular swept footprint, quasi-steady speed-dependent acceleration envelope  
**Primary objective:** minimum closed-lap traversal time  
**Required geometric property:** all four safety-expanded rectangle vertices remain inside the track lane continuously

---

## 0. Critical interpretation of the performance requirement

“Millions of samples per second” must be defined precisely.

Millions of **fully resolved, dynamically solved, and continuously certified complete laps per second** are not a credible requirement for a several-thousand-station circuit discretization on one RTX 4080. Millions of:

- latent candidate mutations per second,
- coarse candidate proxies per second, or
- candidate–track-station evaluations per second

are credible.

The implementation shall report at least four separate rates:

$$
R_{\rm station}
=
\frac{\text{candidate-station evaluations}}{\text{second}},
$$
$$
R_{\rm proxy}
=
\frac{\text{coarse proxy candidate scores}}{\text{second}},
$$
$$
R_{\rm full}
=
\frac{\text{full speed-profile candidate scores}}{\text{second}},
$$
$$
R_{\rm certified}
=
\frac{\text{continuously certified candidates}}{\text{second}}.
$$
For a candidate using $N_s$ path stations and $P$ effective geometry/dynamics passes,

$$
R_{\rm full}
\lesssim
\frac{R_{\rm station}}{N_sP}.
$$
The optimizer shall therefore use a **multi-fidelity funnel**:

1. extremely fast structural generation;
2. coarse geometric screening;
3. approximate lap-time ranking;
4. full forward/backward speed-profile evaluation;
5. local high-resolution optimization;
6. continuous geometric certification.

The RTX 4080 has 9,728 CUDA cores, 16 GB GDDR6X memory, and approximately 49 TFLOPS nominal FP32 shader throughput. These characteristics support very wide candidate batches, but do not eliminate the sequential component of a closed-loop speed-profile solve.

---

# 1. Scope

The system shall optimize a closed planar vehicle-center trajectory

$$
\mathbf r(u)=
\begin{bmatrix}
x(u)\\
y(u)
\end{bmatrix},
\qquad
u\in S^1=[0,1),
$$
and its periodic speed profile

$$
v(u)>0
$$
to minimize

$$
\boxed{
T=
\oint_{\mathbf r}\frac{d\ell}{v}
}
$$
subject to:

1. the trajectory being closed and periodic;
2. regularity of the trajectory;
3. all four safety-expanded vehicle vertices staying inside the lane;
4. a hard maximum speed;
5. acceleration and braking limits;
6. lateral-grip limits;
7. a combined acceleration superellipse;
8. aerodynamic drag;
9. aerodynamic downforce;
10. an optional geometric curvature limit;
11. periodic dynamic feasibility;
12. explicit curvature-quality requirements.

The authoritative track geometry shall remain the supplied PH curve and its exact or numerically certified offset boundaries.

The optimized racing trajectory shall **not** be required to remain a PH curve. The canonical optimizer representation shall instead be a periodic spline with sufficient regularity to prevent curvature and curvature-rate jumps.

PH curves are well suited to the track representation because they admit exact arc-length evaluation and rational offset curves.

---

# 2. Model assumptions

Version 1.0 shall use the following assumptions.

## 2.1 Vehicle reference point

The optimized trajectory represents the center of the rectangle.

If a later vehicle model uses the center of mass, rear axle, front axle, or another body-fixed point, the rectangle offsets shall be generalized to

$$
x_{\rm front},\quad
x_{\rm rear},\quad
y_{\rm left},\quad
y_{\rm right}.
$$
Version 1.0 uses a centered rectangle.

## 2.2 Vehicle yaw

The vehicle body yaw shall equal the trajectory tangent yaw:

$$
\psi(u)
=
\operatorname{atan2}\!\left(y_u,x_u\right).
$$
Thus version 1.0 assumes zero body sideslip.

A future dynamic model may introduce body sideslip $\beta_{\rm body}$:

$$
\psi_{\rm body}
=
\psi_{\rm path}+\beta_{\rm body}.
$$
The corner-containment subsystem shall be written so this extension does not require architectural changes.

## 2.3 Tire and aerodynamic model

The supplied base acceleration, base braking, and base lateral grip are interpreted as zero-aerodynamic-load acceleration capacities.

Aerodynamic downforce increases the three tire-force capacities in proportion to total normal load.

Aerodynamic drag acts outside the tire acceleration superellipse and always opposes motion.

The current UI contains no engine-power setting. The optimizer shall not silently infer one. High-speed acceleration is limited only by:

- drag,
- downforce-modified grip,
- the acceleration superellipse,
- and the hard maximum-speed setting.

## 2.4 Track topology

The lane shall be a simple closed annular strip.

The PH centerline and its two offsets shall not:

- self-intersect;
- cross each other;
- collapse to zero width;
- or produce an ambiguous longitudinal track coordinate inside the legal lane.

If these properties are not satisfied, track preprocessing shall fail with a diagnostic rather than passing invalid geometry into the optimizer.

---

# 3. Input contract

## 3.1 Vehicle and dynamics settings

The following settings shall be accepted exactly as shown in the supplied interface.

| Setting | Symbol | Default | Unit | Required interpretation |
|---|---:|---:|---:|---|
| Vehicle mass | $m$ | $900$ | kg | Used in drag and downforce accelerations |
| Rectangle length | $L_{\rm car}$ | $4.8$ | m | Physical swept-footprint length |
| Rectangle width | $W_{\rm car}$ | $2.0$ | m | Physical swept-footprint width |
| Safety margin | $m_s$ | $0.05$ | m per side | Added to all four rectangle sides |
| Maximum speed | $v_{\max}$ | $91.6667$ | m/s | Hard speed cap |
| Base acceleration | $a_{+,0}$ | $6$ | m/s² | Zero-speed forward tire-axis capacity |
| Base braking | $a_{-,0}$ | $14$ | m/s² | Zero-speed braking tire-axis capacity |
| Base lateral grip | $a_{y,0}$ | $15$ | m/s² | Zero-speed lateral tire capacity |
| Acceleration ellipse exponent | $p$ | $2$ | dimensionless | Combined-force superellipse exponent |
| Drag area | $C_DA$ | $1$ | m² | Quadratic drag parameter |
| Downforce area | $C_LA$ | $3$ | m² | Quadratic downforce parameter |
| Air density | $\rho$ | $1.225$ | kg/m³ | Atmosphere value used by drag/downforce |
| Curvature limit | $\kappa_{\max}$ | blank | 1/m | Blank disables geometric curvature limit |
| Run mode | — | Nondeterministic | — | Fresh seed or reproducible restart sequence |

Validation requirements:

$$
m,L_{\rm car},W_{\rm car},v_{\max},
a_{+,0},a_{-,0},a_{y,0}>0,
$$
$$
m_s,C_DA,C_LA\ge 0,
\qquad
p\ge1.
$$
A nonblank curvature limit must satisfy

$$
\kappa_{\max}>0.
$$
## 3.2 Safety-expanded rectangle

The effective half-length and half-width shall be

$$
a=\frac{L_{\rm car}}2+m_s,
\qquad
b=\frac{W_{\rm car}}2+m_s.
$$
For the supplied defaults,

$$
a=2.45\ {\rm m},
\qquad
b=1.05\ {\rm m}.
$$
The effective corner radius is

$$
\rho_{\rm car}
=
\sqrt{a^2+b^2}
\approx2.66552\ {\rm m}.
$$
The four body-frame vertices are

$$
\mathbf q_{\epsilon,\eta}
=
\begin{bmatrix}
\epsilon a\\
\eta b
\end{bmatrix},
\qquad
\epsilon,\eta\in\{-1,+1\}.
$$
## 3.3 Track settings

The track input shall contain:

- the ordered closed PH centerline segments;
- the traversal direction;
- the left offset distance $w_L(s)$;
- the right offset distance $w_R(s)$;
- the PH segment join data;
- the start/finish reference parameter;
- optional metadata identifying kerbs or excluded lane sections.

Constant-width tracks are represented by constant $w_L,w_R$.

The legal lane is

$$
\Omega_{\rm track}
=
\left\{
\mathbf c(s)+d\mathbf n(s):
-w_R(s)\le d\le w_L(s)
\right\}.
$$
---

# 4. Formal optimization problem

Let $\ell$ denote actual racing-line arc length and let

$$
w(\ell)=v(\ell)^2.
$$
The optimization problem is

$$
\min_{\mathbf r,w}
\quad
T=
\int_0^{L_{\rm lap}}
\frac{d\ell}{\sqrt{w(\ell)}}.
$$
Subject to:

$$
\mathbf r(0)=\mathbf r(1),
$$
$$
\mathbf r^{(j)}(0)=\mathbf r^{(j)}(1),
\qquad j=1,\ldots,4,
$$
$$
\|\mathbf r_u\|>0,
$$
$$
0<w\le v_{\max}^2,
$$
$$
\mathbf V_{\epsilon,\eta}(u)
\in\Omega_{\rm track}
\quad
\forall u,\epsilon,\eta,
$$
and the dynamic constraints defined in Section 9.

Closure and derivative periodicity shall be satisfied **by representation**, not by penalty or rejection.

---

# 5. Track preprocessing

Track preprocessing shall run once per track and shall produce immutable GPU-resident data.

## 5.1 PH arc-length coordinate

For every PH segment, compute its exact cumulative arc-length polynomial.

Construct the periodic mapping

$$
s\longleftrightarrow(j,t),
$$
where $j$ is the PH segment and $t\in[0,1]$ its local parameter.

The GPU representation shall contain:

- cumulative segment lengths;
- inverse-arc-length lookup seeds;
- PH coefficients;
- derivative coefficients;
- left/right offset data.

A lookup table may be used for initialization, followed by one safeguarded Newton iteration.

## 5.2 Track validity checks

Track preprocessing shall verify:

### Regular centerline

$$
\|\mathbf c'(t)\|\ge \sigma_{\min}>0.
$$
### Closed position and tangent

$$
\mathbf c(0)=\mathbf c(L),
\qquad
\mathbf t(0)=\mathbf t(L).
$$
### Local offset regularity

For arc-length coordinate $s$,

$$
1-\kappa_0(s)d>0
$$
shall hold with a positive numerical margin for every legal lateral offset

$$
d\in[-w_R(s),w_L(s)].
$$
### Global injectivity

The lane ribbon shall not overlap itself. This requires a global self-distance test in addition to the local curvature-radius condition.

### Minimum usable width

The track shall contain at least one continuous center trajectory for the safety-expanded vehicle rectangle.

Failure of any validation shall stop optimization.

## 5.3 Authoritative boundaries

The authoritative boundaries are

$$
\mathbf b_L(s)
=
\mathbf c(s)+w_L(s)\mathbf n(s),
$$
$$
\mathbf b_R(s)
=
\mathbf c(s)-w_R(s)\mathbf n(s).
$$
These may be evaluated directly as rational PH offsets or through adaptively subdivided rational segments with a certified geometric error bound.

## 5.4 Smooth auxiliary optimization spine

A $C^2$ PH centerline shall not be used directly as the carrier of the optimized lateral field if continuous curvature rate is required. Its higher-derivative discontinuities can propagate into offset trajectories.

The implementation shall construct a separate periodic auxiliary spine

$$
\mathbf c_{\rm ref}(u),
\qquad u\in[0,1),
$$
using a periodic degree-7 B-spline with simple knots.

This gives

$$
\mathbf c_{\rm ref}\in C^6.
$$
The fit shall minimize

$$
J_{\rm ref}
=
\sum_j
\omega_j
\left\|
\mathbf c_{\rm ref}(u_j)-\mathbf c_{\rm PH}(s_j)
\right\|^2
+
\lambda_{\rm ref}
\int_0^1
\left\|
\mathbf c_{\rm ref}^{(4)}(u)
\right\|^2du.
$$
Subject to:

- periodicity;
- regularity;
- forward correspondence with the PH centerline;
- containment inside the lane;
- bounded fit error;
- a valid normal-coordinate ribbon.

The PH centerline remains the ground truth for containment. The auxiliary spine is only a smooth coordinate chart.

## 5.5 Reference-frame tables

At every evaluation station, preprocess:

$$
\mathbf c_{\rm ref},
\quad
\mathbf c_{\rm ref}^{(1)},\ldots,
\mathbf c_{\rm ref}^{(4)},
$$
$$
\mathbf t_{\rm ref},
\quad
\mathbf n_{\rm ref},
\quad
\mathbf n_{\rm ref}^{(1)},\ldots,
\mathbf n_{\rm ref}^{(4)}.
$$
These values shall reside in read-only GPU memory.

---

# 6. Rectangle-safe generation corridor

High acceptance requires a feasibility-preserving decoder rather than unconstrained Cartesian samples.

## 6.1 Heading-dependent feasible center interval

For reference station $u$, lateral center displacement $d$, and relative body heading $\beta$, define the pose

$$
\mathbf p(u,d)
=
\mathbf c_{\rm ref}(u)
+
d\mathbf n_{\rm ref}(u),
$$
$$
\psi_{\rm body}
=
\psi_{\rm ref}(u)+\beta.
$$
The four vertices are

$$
\mathbf V_{\epsilon,\eta}(u,d,\beta)
=
\mathbf p(u,d)
+
R(\psi_{\rm ref}+\beta)
\mathbf q_{\epsilon,\eta}.
$$
Precompute the set

$$
\mathcal D(u,\beta)
=
\left\{
d:
\mathbf V_{\epsilon,\eta}(u,d,\beta)
\in\Omega_{\rm track}
\ \forall\epsilon,\eta
\right\}.
$$
For a regular racing-track ribbon, this set will normally be one interval:

$$
\mathcal D(u,\beta)
=
[\underline d(u,\beta),\overline d(u,\beta)].
$$
If it is disconnected, the track coordinate is unsuitable at that location and preprocessing shall report it.

## 6.2 Robust initial corridor

Choose an internal relative-yaw range

$$
|\beta|\le\beta_{\rm safe}.
$$
Compute

$$
\underline d_{\rm robust}(u)
=
\max_{|\beta|\le\beta_{\rm safe}}
\underline d(u,\beta),
$$
$$
\overline d_{\rm robust}(u)
=
\min_{|\beta|\le\beta_{\rm safe}}
\overline d(u,\beta).
$$
Fit periodic $C^4$ **inward** approximations

$$
\underline d_{\rm safe}(u)
\ge
\underline d_{\rm robust}(u),
$$
$$
\overline d_{\rm safe}(u)
\le
\overline d_{\rm robust}(u).
$$
Interpolation and boundary-approximation error margins shall be included.

The global-search population shall initially be generated inside this corridor.

## 6.3 Orientation-independent fallback corridor

An orientation-independent but conservative corridor may be constructed by eroding the lane by the rectangle circumradius

$$
\rho_{\rm car}=\sqrt{a^2+b^2}.
$$
Any vehicle center whose Euclidean boundary clearance exceeds $\rho_{\rm car}$ is safe for every orientation.

This corridor is useful for:

- guaranteed-valid initial seeds;
- debugging;
- tracks where heading-dependent preprocessing is temporarily unavailable.

It shall not be the final optimization corridor because it can discard useful track width.

---

# 7. Canonical racing-line representation

## 7.1 Periodic quintic lateral field

Use a periodic quintic B-spline basis

$$
B_i^{(5)}(u),
\qquad i=0,\ldots,N_c-1,
$$
with cyclic indices.

Let the bounded coefficients satisfy

$$
-1\le\alpha_i\le1.
$$
Define

$$
z(u)
=
\sum_{i=0}^{N_c-1}
\alpha_i B_i^{(5)}(u).
$$
Periodic B-spline basis functions are nonnegative and form a partition of unity, so

$$
-1\le z(u)\le1
$$
for every continuous $u$, not only at evaluation nodes.

Define

$$
m_d(u)
=
\frac{
\underline d_{\rm safe}(u)
+
\overline d_{\rm safe}(u)
}{2},
$$
$$
h_d(u)
=
\frac{
\overline d_{\rm safe}(u)
-
\underline d_{\rm safe}(u)
}{2},
$$
and

$$
\boxed{
d(u)=m_d(u)+h_d(u)z(u).
}
$$
Therefore

$$
\underline d_{\rm safe}(u)
\le d(u)\le
\overline d_{\rm safe}(u)
$$
for all $u$.

The racing-line center is

$$
\boxed{
\mathbf r(u)
=
\mathbf c_{\rm ref}(u)
+
d(u)\mathbf n_{\rm ref}(u).
}
$$
## 7.2 Closure and regularity

Because every component is periodic,

$$
\mathbf r^{(j)}(0)
=
\mathbf r^{(j)}(1),
\qquad
j=0,\ldots,4.
$$
The quintic lateral field is $C^4$. Since the reference normal is at least $C^5$,

$$
\boxed{
\mathbf r\in C^4.
}
$$
For a regular planar curve, this implies

$$
\boxed{
\kappa\in C^2.
}
$$
Thus the following are continuous:

$$
\kappa,
\qquad
\frac{d\kappa}{d\ell},
\qquad
\frac{d^2\kappa}{d\ell^2}.
$$
There shall be no curvature or curvature-rate jumps at spline knots or at the periodic seam.

B-splines provide local control, fixed continuity, and a substantially lower-dimensional racing-line representation than dense pointwise variables; these properties have been used directly in autonomous-racing trajectory optimization.

## 7.3 Derivatives

Let primes denote differentiation with respect to $u$.

$$
\mathbf r'
=
\mathbf c_{\rm ref}'
+d'\mathbf n_{\rm ref}
+d\mathbf n_{\rm ref}',
$$
$$
\mathbf r''
=
\mathbf c_{\rm ref}''
+d''\mathbf n_{\rm ref}
+2d'\mathbf n_{\rm ref}'
+d\mathbf n_{\rm ref}'',
$$
with analogous product-rule expressions through $\mathbf r^{(4)}$.

All spline basis weights and derivative weights shall be precomputed at evaluation stations.

## 7.4 Forward-progression constraint

Define

$$
q(u)=\|\mathbf r'(u)\|.
$$
Require

$$
q(u)\ge q_{\min}>0.
$$
Also require positive longitudinal progression relative to the reference spine:

$$
\frac{
\mathbf r'(u)\cdot\mathbf c_{\rm ref}'(u)
}{
\|\mathbf r'(u)\|
\|\mathbf c_{\rm ref}'(u)\|
}
\ge\tau_{\rm progress}>0.
$$
This prevents:

- local reversal;
- loops;
- ambiguous track-station assignment;
- nearly singular parameterization.

## 7.5 Actual path differential geometry

The actual arc-length differential is

$$
d\ell=q(u)\,du.
$$
The unit tangent is

$$
\mathbf T=\frac{\mathbf r'}q.
$$
The signed curvature is

$$
\boxed{
\kappa(u)
=
\frac{
x'y''-y'x''
}{
q^3
}.
}
$$
Curvature derivatives with respect to actual arc length are

$$
\kappa_\ell
=
\frac{\kappa_u}{q},
$$
$$
\kappa_{\ell\ell}
=
\frac{\kappa_{uu}}{q^2}
-
\frac{\kappa_u q_u}{q^3}.
$$
These quantities shall be computed analytically from spline derivatives, not by finite differencing sampled Cartesian coordinates.

---

# 8. Exact vehicle-corner containment

## 8.1 Corner transformation

The path yaw is

$$
\psi(u)=\operatorname{atan2}(y',x').
$$
The world-space corners are

$$
\boxed{
\mathbf V_{\epsilon,\eta}(u)
=
\mathbf r(u)
+
R(\psi(u))
\mathbf q_{\epsilon,\eta}.
}
$$
The hard geometric constraint is

$$
\boxed{
\mathbf V_{\epsilon,\eta}(u)
\in\Omega_{\rm track}
\quad
\forall u,\epsilon,\eta.
}
$$
## 8.2 Fast ribbon-coordinate query

For coarse GPU evaluation, each corner shall be converted to track ribbon coordinates.

For a query point $\mathbf x$, solve

$$
f(s)
=
\bigl(
\mathbf c_{\rm PH}(s)-\mathbf x
\bigr)
\cdot
\mathbf c_{\rm PH}'(s)
=0.
$$
Newton update:

$$
s_{\rm new}
=
s-
\frac{
(\mathbf c-\mathbf x)\cdot\mathbf c'
}{
\|\mathbf c'\|^2+
(\mathbf c-\mathbf x)\cdot\mathbf c''
}.
$$
The initial estimate shall use the known center station and the corner's approximate longitudinal displacement.

For relative yaw $\beta$ and body-frame corner coordinates $(\xi,\eta)$,

$$
\Delta s
\approx
\xi\cos\beta-\eta\sin\beta.
$$
After projection, compute the signed lateral coordinate

$$
d_x=
\bigl(
\mathbf x-\mathbf c_{\rm PH}(s_x)
\bigr)
\cdot\mathbf n_{\rm PH}(s_x).
$$
Require

$$
-w_R(s_x)\le d_x\le w_L(s_x).
$$
The fast query may use cubic-Hermite interpolation of PH lookup tables plus one Newton correction.

## 8.3 Exact final query

Final candidates shall be checked using:

- exact PH segment evaluation;
- safeguarded projection;
- exact or certified rational-offset boundary evaluation;
- FP64 arithmetic.

The final check shall not rely only on a raster texture or on the coarse lookup tables.

## 8.4 Conservative boundary-distance representation

For continuous certification, preprocess each PH offset boundary into adaptively subdivided rational or polynomial pieces with maximum Hausdorff error

$$
\varepsilon_{\rm boundary}.
$$
Build a spatial BVH over these pieces.

Let $d_{\rm poly}$ be the distance to the approximate boundary. A conservative boundary-distance estimate is

$$
d_{\rm conservative}
=
d_{\rm poly}-\varepsilon_{\rm boundary}.
$$
Only positive conservative clearance counts as certified.

## 8.5 Continuous, not merely nodal, containment

Testing the corners only at trajectory stations is insufficient.

Let $\mathbf V_j(\ell)$ denote one corner trajectory. Since

$$
\mathbf V_j
=
\mathbf r+R(\psi)\mathbf q_j,
$$
and

$$
\frac{d\psi}{d\ell}=\kappa,
$$
$$
\frac{d\mathbf V_j}{d\ell}
=
\mathbf T
+
\kappa R(\psi)J\mathbf q_j.
$$
Therefore

$$
\left\|
\frac{d\mathbf V_j}{d\ell}
\right\|
\le
1+\rho_{\rm car}|\kappa|.
$$
For an interval $I$ with midpoint $\ell_m$, half-length $h_I$, and certified curvature bound $\kappa_{I,\max}$, every point in the interval lies within

$$
\Delta_I
=
\left(
1+\rho_{\rm car}\kappa_{I,\max}
\right)h_I
$$
of the midpoint corner.

Because Euclidean signed distance is 1-Lipschitz, the interval is certified if

$$
\boxed{
D_{\Omega}
\bigl(
\mathbf V_j(\ell_m)
\bigr)
>
\Delta_I+\varepsilon_{\rm cert}.
}
$$
Otherwise subdivide the interval recursively.

The final candidate is valid only if every interval for every corner is either:

- certified by this bound; or
- subdivided until a stronger interval/Bézier bound certifies it.

---

# 9. Vehicle dynamics model

Let

$$
g=9.80665\ {\rm m/s^2}.
$$
## 9.1 Aerodynamic drag

Dynamic pressure:

$$
q_a(v)
=
\frac12\rho v^2.
$$
Drag force:

$$
F_D(v)=q_a(v)C_DA.
$$
Drag acceleration:

$$
\boxed{
a_D(v)=\frac{q_a(v)C_DA}{m}.
}
$$
## 9.2 Aerodynamic downforce

Downforce:

$$
F_L(v)=q_a(v)C_LA.
$$
Normal-load multiplier:

$$
\boxed{
\chi(v)
=
1+\frac{F_L(v)}{mg}
=
1+
\frac{\rho C_LA}{2mg}v^2.
}
$$
Define

$$
\gamma
=
\frac{\rho C_LA}{2mg},
$$
so that

$$
\chi(v)=1+\gamma v^2.
$$
## 9.3 Speed-dependent tire capacities

Forward acceleration capacity:

$$
A_+(v)
=
a_{+,0}\chi(v).
$$
Braking capacity:

$$
A_-(v)
=
a_{-,0}\chi(v).
$$
Lateral capacity:

$$
A_y(v)
=
a_{y,0}\chi(v).
$$
This is a quasi-steady $g$-$g$-$v$ envelope. Minimum-lap-time simulation commonly represents speed-dependent vehicle capability through this type of acceleration envelope, particularly where downforce widens the available $g$-$g$ region at speed.

## 9.4 Required lateral acceleration

At speed $v$,

$$
a_y=v^2\kappa.
$$
Define normalized lateral utilization

$$
r_y(v,\kappa)
=
\frac{|v^2\kappa|}{A_y(v)}.
$$
The state is infeasible if

$$
r_y>1.
$$
## 9.5 Acceleration superellipse

For positive longitudinal tire acceleration $a_x^{\rm tire}\ge0$,

$$
\left(
\frac{a_x^{\rm tire}}{A_+(v)}
\right)^p
+
\left(
\frac{|a_y|}{A_y(v)}
\right)^p
\le1.
$$
For braking magnitude $b_x^{\rm tire}\ge0$,

$$
\left(
\frac{b_x^{\rm tire}}{A_-(v)}
\right)^p
+
\left(
\frac{|a_y|}{A_y(v)}
\right)^p
\le1.
$$
Thus

$$
\boxed{
a_{x,+}^{\rm tire}(v,\kappa)
=
A_+(v)
\left[
1-r_y(v,\kappa)^p
\right]_+^{1/p}
}
$$
and

$$
\boxed{
a_{x,-}^{\rm tire}(v,\kappa)
=
A_-(v)
\left[
1-r_y(v,\kappa)^p
\right]_+^{1/p}.
}
$$
For the default $p=2$, a specialized square-root kernel shall be used instead of a generic power function.

## 9.6 Net tangential acceleration interval

Maximum net acceleration:

$$
\boxed{
a_{\max}(v,\kappa)
=
a_{x,+}^{\rm tire}(v,\kappa)-a_D(v).
}
$$
Maximum net deceleration magnitude:

$$
\boxed{
b_{\max}(v,\kappa)
=
a_{x,-}^{\rm tire}(v,\kappa)+a_D(v).
}
$$
Therefore

$$
-b_{\max}(v,\kappa)
\le
\frac{dv}{dt}
\le
a_{\max}(v,\kappa).
$$
## 9.7 Pointwise lateral speed cap

The pure-lateral condition is

$$
v^2|\kappa|
\le
a_{y,0}(1+\gamma v^2).
$$
Let $w=v^2$. Then

$$
w
\left(
|\kappa|-a_{y,0}\gamma
\right)
\le
a_{y,0}.
$$
If

$$
|\kappa|>a_{y,0}\gamma,
$$
the lateral cap is

$$
\boxed{
w_{\rm lat}
=
\frac{a_{y,0}}
{
|\kappa|-a_{y,0}\gamma
}.
}
$$
Otherwise this simplified downforce model imposes no finite lateral-only cap, and the hard maximum speed applies.

The pointwise speed cap is

$$
\boxed{
\bar w
=
\min
\left(
v_{\max}^2,
w_{\rm lat}
\right).
}
$$
## 9.8 Optional curvature constraint

If the curvature setting is nonblank, require

$$
\boxed{
|\kappa(u)|\le\kappa_{\max}.
}
$$
This is a geometric hard constraint independent of the lateral-grip speed cap.

---

# 10. Closed-lap speed-profile solver

For a fixed candidate geometry, the optimizer shall solve the maximum feasible periodic speed profile.

## 10.1 Spatial state

Using

$$
w=v^2,
$$
$$
\frac{dw}{d\ell}
=
2\frac{dv}{dt}.
$$
Therefore

$$
-2b_{\max}(\sqrt w,\kappa)
\le
\frac{dw}{d\ell}
\le
2a_{\max}(\sqrt w,\kappa).
$$
## 10.2 Discretization

For stations $i=0,\ldots,N_s-1$, store:

$$
\kappa_i,\quad
\Delta\ell_i,\quad
\bar w_i.
$$
Indices are periodic.

Geometry shall be evaluated at nodes and segment quadrature points.

## 10.3 Forward propagation operator

Given $w_i$, define $F_i(w_i)$ as the largest admissible $w_{i+1}$ satisfying the implicit midpoint approximation

$$
w_{i+1}
=
w_i
+
2\Delta\ell_i
a_{\max}
\left(
\sqrt{\frac{w_i+w_{i+1}}2},
\kappa_{i+1/2}
\right).
$$
Use:

- two or three safeguarded Newton iterations;
- a bisection fallback;
- clamping to $[0,\bar w_{i+1}]$.

## 10.4 Backward braking operator

Given $w_{i+1}$, define $B_i(w_{i+1})$ as the largest $w_i$ satisfying

$$
w_i
=
w_{i+1}
+
2\Delta\ell_i
b_{\max}
\left(
\sqrt{\frac{w_i+w_{i+1}}2},
\kappa_{i+1/2}
\right).
$$
Again use safeguarded Newton or bisection.

## 10.5 Cyclic fixed-point algorithm

Initialize

$$
w_i\leftarrow\bar w_i.
$$
Then repeatedly perform:

### Forward sweep

$$
w_{i+1}
\leftarrow
\min
\left(
w_{i+1},
\bar w_{i+1},
F_i(w_i)
\right).
$$
### Backward sweep

$$
w_i
\leftarrow
\min
\left(
w_i,
\bar w_i,
B_i(w_{i+1})
\right).
$$
Repeat around the complete ring until

$$
\max_i
\frac{
|w_i^{(k+1)}-w_i^{(k)}|
}{
1+w_i^{(k)}
}
<
\varepsilon_w.
$$
Starting from pointwise upper bounds makes the iteration monotonically nonincreasing.

Forward/backward propagation is standard in racing speed-profile construction; closely related time-optimal path-parameterization methods compute controllable speed sets backward and then select the largest feasible controls forward.

## 10.6 Lap-time quadrature

After convergence,

$$
\boxed{
T
\approx
\sum_i
\frac{
2\Delta\ell_i
}{
\sqrt{w_i}+\sqrt{w_{i+1}}
}.
}
$$
Use compensated summation for the final FP64 evaluation.

## 10.7 Speed-profile optimality check

For every station define the slacks

$$
s_i^{\rm cap}
=
\bar w_i-w_i,
$$
$$
s_i^{\rm acc}
=
F_{i-1}(w_{i-1})-w_i,
$$
$$
s_i^{\rm brake}
=
B_i(w_{i+1})-w_i.
$$
At a maximum feasible speed profile, at least one shall be active within tolerance:

$$
\boxed{
\min
\left(
s_i^{\rm cap},
s_i^{\rm acc},
s_i^{\rm brake}
\right)
\approx0.
}
$$
If all three are significantly positive, the profile can be locally increased and is not time-optimal for the fixed path.

---

# 11. Curvature-quality requirements

High spline continuity alone does not prevent narrow curvature spikes. The optimizer shall combine structural continuity, oversampling, derivative diagnostics, and a secondary smoothing objective.

## 11.1 Structural requirement

The canonical trajectory shall be $C^4$, giving

$$
\kappa\in C^2.
$$
No knot or periodic-seam jumps are permitted in:

$$
\kappa,\quad
\kappa_\ell,\quad
\kappa_{\ell\ell}.
$$
## 11.2 Oversampling requirement

Each spline knot span shall be evaluated at no fewer than:

- 4 interior points during global screening;
- 8 interior points during medium evaluation;
- adaptive quadrature points during final evaluation.

Any span exhibiting large:

$$
|\kappa_\ell|,
\quad
|\kappa_{\ell\ell}|,
\quad
|dv/d\ell|,
$$
or small corner clearance shall be subdivided.

## 11.3 Dimensionless curvature regularizer

Let

$$
L_e=L_{\rm car}+2m_s.
$$
Define

$$
\boxed{
R_\kappa
=
\frac1{L_{\rm lap}}
\int_0^{L_{\rm lap}}
\left[
\left(
L_e^2\kappa_\ell
\right)^2
+
\eta_\kappa
\left(
L_e^3\kappa_{\ell\ell}
\right)^2
\right]d\ell.
}
$$
This regularizer is dimensionless.

It shall not dominate lap time during global optimization.

## 11.4 Lateral-jerk diagnostic

The normal acceleration is

$$
a_y=v^2\kappa.
$$
Its time derivative is

$$
\boxed{
j_y
=
2va_x\kappa
+
v^3\kappa_\ell.
}
$$
The optimizer shall report:

$$
\max|j_y|,
\qquad
\operatorname{RMS}(j_y).
$$
No hard jerk limit is imposed unless a future setting explicitly supplies one.

## 11.5 Minimum-time-preserving smoothing

After the best lap-time trajectory is found, solve the secondary problem

$$
\boxed{
\min R_\kappa
}
$$
subject to

$$
T
\le
T_{\rm best}+\Delta T_{\rm allowed}
$$
and all hard constraints.

Use

$$
\Delta T_{\rm allowed}
=
\max
\left(
\varepsilon_{\rm rel}T_{\rm best},
2\varepsilon_{\rm discretization}
\right).
$$
A suitable initial value is

$$
\varepsilon_{\rm rel}=10^{-5}\text{ to }10^{-4},
$$
subject to mesh-convergence evidence.

This stage removes numerically accidental local imperfections without trading away meaningful lap time.

Track-curvature smoothness is known to affect minimum-lap-time solver convergence, and racing formulations commonly introduce steering-rate limits or smooth curvature representations rather than accepting arbitrarily busy curvature data.

---

# 12. Constraint handling and candidate ranking

Fixed scalar penalty weights shall not be the sole feasibility mechanism.

## 12.1 Hard-constraint violation measure

Compute normalized violations for:

- corner containment;
- trajectory regularity;
- forward progression;
- curvature limit;
- lateral-speed feasibility;
- speed-profile convergence;
- nonfinite values.

Define

$$
V_{\max}
=
\max_j V_j.
$$
## 12.2 Feasible-first ordering

Candidates shall be sorted lexicographically by:

$$
\boxed{
\left(
I_{\rm infeasible},
V_{\max},
T,
R_\kappa,
-L_{\rm clearance}
\right),
}
$$
where

$$
I_{\rm infeasible}
=
\begin{cases}
0,&V_{\max}=0,\\
1,&V_{\max}>0.
\end{cases}
$$
Thus:

1. every feasible candidate outranks every infeasible candidate;
2. infeasible candidates are ranked by distance to feasibility;
3. feasible candidates are ranked primarily by lap time;
4. nearly equal lap times are ranked by curvature quality;
5. remaining ties favor greater clearance.

## 12.3 Epsilon equivalence for lap time

Two candidates shall be considered lap-time-equivalent when

$$
|T_1-T_2|
\le
\max
\left(
\varepsilon_T,
c_T\varepsilon_{\rm mesh}
\right).
$$
Within this set, use $R_\kappa$ and minimum clearance as tie-breakers.

---

# 13. Optimization algorithm

The recommended optimizer is a **hierarchical island evolution strategy followed by batched local trust-region refinement**.

A single dense CMA-ES covariance matrix shall not be used at high dimension because its $O(N_c^2)$ state and update cost work against the GPU-oriented design.

## 13.1 Stage A — seed generation

Generate structurally closed seeds from:

1. the centerline-equivalent path;
2. the orientation-independent eroded corridor center;
3. low-frequency sinusoidal lateral fields;
4. left-biased and right-biased paths;
5. an approximate minimum-curvature path;
6. random smooth periodic fields.

Random fields shall be low-pass filtered in coefficient space before decoding.

All guaranteed-valid seed families shall remain inside the robust center corridor.

## 13.2 Stage B — coarse global feature discovery

Use:

- many independent islands;
- large batched populations;
- periodic quintic splines with coarse knot spacing;
- coarse geometric sampling;
- a cheap lap-time proxy;
- full speed evaluation for a broad elite subset.

Each island maintains:

$$
\boldsymbol\mu,
\qquad
\boldsymbol\sigma,
$$
where $\boldsymbol\mu$ is the coefficient mean and $\boldsymbol\sigma$ diagonal mutation scale.

Generate antithetic pairs:

$$
\boldsymbol\alpha^{(+)}
=
\mathcal R
\left(
\boldsymbol\mu+
\boldsymbol\sigma\odot\boldsymbol\epsilon
\right),
$$
$$
\boldsymbol\alpha^{(-)}
=
\mathcal R
\left(
\boldsymbol\mu-
\boldsymbol\sigma\odot\boldsymbol\epsilon
\right),
$$
where $\mathcal R$ reflects values into $[-1,1]$.

Use elite rank weights to update

$$
\boldsymbol\mu
\leftarrow
(1-\eta_\mu)\boldsymbol\mu
+
\eta_\mu
\sum_{k\in E}w_k\boldsymbol\alpha_k,
$$
and similarly update diagonal variance.

Requirements:

- retain a nonzero variance floor;
- migrate elites between islands periodically;
- restart stagnant islands;
- reserve a fraction of evaluations for random exploration;
- retain multiple geometrically diverse near-optimal paths.

## 13.3 Coarse lap-time proxy

For all geometrically valid candidates, first compute

$$
T_{\rm proxy}
=
\sum_i
\frac{\Delta\ell_i}
{
\min(v_{\max},v_{{\rm lat},i})
}.
$$
Add inexpensive indicators for:

- path length;
- braking demand implied by speed-cap drops;
- curvature-rate energy;
- minimum corner clearance.

The proxy shall not choose the final candidate.

A configurable fraction of:

- top proxy candidates, and
- randomly selected nonelite candidates

shall receive a full speed-profile evaluation. Random retention prevents proxy bias from permanently excluding lines with superior acceleration-exit trade-offs.

## 13.4 Stage C — hierarchical spline refinement

Refine the periodic spline using exact knot insertion.

The refined control net shall initially reproduce the coarse trajectory exactly.

Recommended physical knot spacing sequence:

$$
40\ {\rm m}
\rightarrow
20\ {\rm m}
\rightarrow
10\ {\rm m}
\rightarrow
5\ {\rm m},
$$
with local refinement where justified.

Knot insertion priority shall increase with:

$$
I_j
=
c_1\max_{I_j}|\kappa_\ell|
+
c_2\max_{I_j}|\kappa_{\ell\ell}|
+
c_3\max_{I_j}|dv/d\ell|
+
c_4A_j^{\rm boundary}
+
c_5S_j^{\rm lap},
$$
where:

- $A_j^{\rm boundary}$ indicates changing active boundary constraints;
- $S_j^{\rm lap}$ is a local lap-time sensitivity estimate.

The initial knot grid shall include or closely bracket:

- PH segment joins;
- track-curvature extrema;
- rapid width changes;
- chicanes;
- hairpins;
- boundary-clearance bottlenecks.

## 13.5 Mutation scaling across resolution

A displacement perturbation of amplitude $A$ over length scale $h$ produces curvature change of order

$$
A/h^2.
$$
Mutation amplitudes at finer levels shall therefore scale approximately as

$$
\sigma_{\rm position}(h)
\propto h^2.
$$
During the curvature-polish stage, use the stronger scaling

$$
\sigma_{\rm position}(h)
\propto h^3
$$
to suppress high-frequency curvature-rate disturbances.

## 13.6 Stage D — medium-resolution local evolution

For each retained elite:

- use the refined control net;
- reduce mutation radius;
- widen from the robust generation corridor toward the exact feasible corridor;
- evaluate every candidate with the full speed solver;
- use exact four-corner checks at all dynamic nodes;
- preserve multiple local minima.

Invalid offspring shall be repaired by backtracking toward their feasible parent:

$$
\boldsymbol\alpha_{\rm trial}
=
\boldsymbol\alpha_{\rm parent}
+
\lambda
\left(
\boldsymbol\alpha_{\rm proposal}
-
\boldsymbol\alpha_{\rm parent}
\right),
$$
with

$$
\lambda=1,\frac12,\frac14,\ldots
$$
until the candidate is valid or the minimum step is reached.

This preserves closure and smoothness automatically.

## 13.7 Stage E — batched local pattern search

For the best $K$ elites, evaluate batched positive and negative coefficient perturbations:

$$
\boldsymbol\alpha\pm h_i\mathbf e_i.
$$
Use:

- central finite differences where the active set is stable;
- one-sided differences near coefficient or lane boundaries;
- trust-region step acceptance;
- cyclic block-coordinate updates;
- quadratic interpolation when three consistent samples are available.

All coefficient directions for all elites shall be evaluated in one or a few large GPU batches.

This stage is intended to eliminate small local defects that population evolution may leave unresolved.

## 13.8 Stage F — smoothness-constrained polish

Solve the minimum-time-preserving smoothing problem from Section 11.5.

Then rerun a final lap-time refinement from the smoothed path.

## 13.9 Stage G — high-resolution certification

The final stage shall use:

- FP64 path geometry;
- exact PH boundary queries;
- high-resolution speed propagation;
- adaptive corner-containment subdivision;
- mesh refinement;
- basis refinement;
- active-limit diagnostics.

Only this stage may mark a result `CERTIFIED`.

---

# 14. GPU implementation

## 14.1 CUDA target

Compile native code for

$$
\texttt{sm\_89}
$$
and include suitable PTX fallback if broader Ada compatibility is required.

The application shall query device properties at runtime and derive:

- batch size;
- shared-memory use;
- register budget;
- maximum active blocks;
- available memory.

## 14.2 Device-resident pipeline

After track upload, the generation loop shall remain GPU-resident.

CPU–GPU transfers shall be limited to:

- user cancellation;
- periodic telemetry;
- occasional top-$K$ candidate export;
- final results.

No complete population shall be copied to the CPU between generations.

## 14.3 Data layout

Candidate-dependent station arrays shall use station-major structure-of-arrays layout:

$$
\texttt{field[station][candidate]}.
$$
Flattened:

$$
\texttt{field[station * batchSize + candidate]}.
$$
During sequential station loops, adjacent threads in a warp then access adjacent candidates at the same station, producing coalesced memory traffic.

NVIDIA's CUDA guidance identifies coalesced global-memory access as a high-priority performance requirement.

Store separate arrays for:

- $w$;
- $\bar w$;
- $\Delta\ell$;
- curvature;
- validity flags;
- optional clearance.

Avoid storing $x,y,\mathbf T,\mathbf n$ for every candidate station unless reused enough to amortize the memory cost.

Recompute cheap quantities where this reduces global-memory bandwidth.

## 14.4 Basis tables

For every resolution level and evaluation station, precompute:

- active control-point indices;
- $B_i$;
- $B_i'$;
- $B_i''$;
- $B_i'''$;
- $B_i''''$.

A quintic spline has six active basis functions per regular span.

These fixed tables shall be shared by every candidate.

## 14.5 Kernel decomposition

Recommended recurring kernel graph:

1. `generate_coefficients`
2. `decode_geometry_and_screen`
3. `compact_geometrically_valid`
4. `compute_proxy_score`
5. `select_full_evaluation_subset`
6. `initialize_speed_caps`
7. `forward_speed_sweep`
8. `backward_speed_sweep`
9. repeat sweeps until fixed count or convergence
10. `compute_lap_time_and_metrics`
11. `rank_candidates`
12. `update_islands`
13. `record_elites`

The recurring sequence shall be captured in a CUDA Graph. CUDA Graphs amortize repeated kernel-launch setup costs and are particularly useful for workflows with many short recurring kernels.

## 14.6 Geometry kernel mapping

Use one thread per

$$
(\text{candidate},\text{station})
$$
for:

- spline evaluation;
- derivatives;
- curvature;
- arc metric;
- four corners;
- fast lane checks;
- pointwise speed cap;
- local smoothness metrics.

All threads in a warp should execute the same spline degree and dynamics branch.

Use a specialized $p=2$ kernel for the default ellipse.

## 14.7 Speed-sweep kernel mapping

Use one thread per candidate for each forward or backward sweep.

Each thread loops sequentially over stations.

Because data are station-major, threads in a warp access:

$$
w[i,c],\quad
w[i,c+1],\ldots
$$
at each common station $i$, preserving coalescing despite the per-candidate serial dependency.

Large numbers of candidates provide the outer parallelism.

## 14.8 Compaction and reductions

Use optimized CUDA primitives for:

- valid-candidate compaction;
- elite selection;
- segmented reductions;
- prefix operations;
- histogramming;
- radix sorting.

CUB provides device-wide and segmented primitives intended for batched GPU operations.

## 14.9 Precision policy

### Global screening

Use FP32 with:

- fused multiply-add;
- fast reciprocal square root;
- specialized trigonometric intrinsics where validated.

### Medium evaluation

Use FP32 geometry and speed propagation, but accumulate lap time in FP64 or compensated FP32.

### Final certification

Use FP64 for:

- spline geometry;
- PH evaluation;
- corner projection;
- curvature;
- speed-profile residuals;
- lap-time accumulation.

The final result shall never depend solely on fast-math screening results.

## 14.10 Random-number generation

Use a counter-based generator such as Philox.

A sample shall be reproducible from:

$$
(\text{global seed},
\text{generation},
\text{island},
\text{candidate},
\text{coefficient}).
$$
This eliminates mutable per-thread RNG state and allows exact regeneration of selected candidates.

## 14.11 Run modes

### Deterministic

- fixed root seed;
- fixed island restart schedule;
- fixed reduction tree;
- no unordered atomic objective accumulation;
- same candidate ordering;
- same kernel graph.

Bitwise reproducibility is required for the same:

- executable;
- GPU model;
- driver;
- CUDA runtime;
- compiler flags.

Across different hardware or compiler versions, require numerical—not bitwise—agreement.

### Nondeterministic

- fresh root seed from operating-system entropy;
- optional randomized island migration;
- optional unordered reductions where performance benefit is material.

## 14.12 Memory budget

The implementation shall keep peak device allocation below 14 GB on a 16 GB RTX 4080.

Batch size shall be selected from:

$$
B
\le
\frac{
M_{\rm available}
}{
4N_sN_{\rm stored\ fields}
+
4N_c
+
M_{\rm overhead}
}.
$$
Candidate fields shall be tiled when necessary.

---

# 15. Multi-fidelity resolution policy

Recommended starting values are:

| Stage | Control spacing | Geometry stations | Speed model | Boundary model |
|---|---:|---:|---|---|
| Seed screening | 40–80 m | 64–128 | lateral/proxy only | robust corridor |
| Global discovery | 20–40 m | 128–512 | proxy + selected full | fast ribbon |
| Medium evolution | 10–20 m | 512–1,024 | full periodic | fast exact corners |
| Local refinement | 5–10 m | 1,024–4,096 | full periodic | exact PH query |
| Certification | adaptive | 4,096+ adaptive | FP64 converged | continuous certificate |

Resolution shall be expressed primarily in physical metres, not only point count.

Narrow or high-curvature features shall receive locally denser stations.

---

# 16. High-acceptance requirements

The global generator shall target:

$$
\boxed{
\text{geometric acceptance}\ge95\%
}
$$
after cheap heading/progression repair.

Local offspring generated from feasible parents shall target:

$$
\boxed{
\text{geometric acceptance}\ge99\%.
}
$$
Acceptance shall be measured separately for:

- safe-corridor membership;
- relative-yaw/progression;
- exact four-corner containment;
- curvature limit;
- dynamic feasibility;
- numerical validity.

If acceptance falls below target, the optimizer shall adapt:

1. mutation amplitude;
2. high-frequency mutation content;
3. robust-corridor width;
4. coefficient-difference limits;
5. parent-backtracking depth.

It shall not merely continue wasting evaluations on invalid candidates.

---

# 17. Track-feature discovery

The optimizer shall not rely on one global low-order spline.

Feature discovery shall be supported by:

- multiple independent islands;
- low-frequency and boundary-biased seeds;
- exact hierarchical knot insertion;
- local support of B-splines;
- adaptive knot placement;
- random retention beyond proxy elites;
- periodic island restarts;
- multiple near-optimal survivors.

The optimizer shall retain at least $K_{\rm diverse}$ near-optimal trajectories using a diversity metric such as

$$
D_{ab}
=
\left[
\frac1{L_0}
\int_0^1
\left(
d_a(u)-d_b(u)
\right)^2du
\right]^{1/2}.
$$
This reduces the risk that all local refinements descend into the same inferior basin.

---

# 18. Numerical optimality and quality report

Every final trajectory shall include an `OptimalityReport`.

## 18.1 Geometry

Report:

$$
L_{\rm lap},
\quad
\max|\kappa|,
\quad
\max|\kappa_\ell|,
\quad
\max|\kappa_{\ell\ell}|,
$$
$$
\min q(u),
$$
$$
\min
\frac{
\mathbf r'\cdot\mathbf c_{\rm ref}'
}{
\|\mathbf r'\|
\|\mathbf c_{\rm ref}'\|
}.
$$
## 18.2 Containment

Report:

- minimum corner clearance;
- corner and station at minimum clearance;
- number of adaptively subdivided intervals;
- maximum boundary approximation error;
- continuous-certification status.

## 18.3 Dynamics

Report:

- maximum speed;
- minimum speed;
- maximum acceleration;
- maximum braking;
- maximum lateral acceleration;
- maximum acceleration-ellipse utilization;
- maximum drag acceleration;
- maximum downforce multiplier;
- maximum and RMS lateral jerk.

## 18.4 Speed-profile optimality

Report:

$$
\max_i
\min
\left(
s_i^{\rm cap},
s_i^{\rm acc},
s_i^{\rm brake}
\right)
$$
after suitable normalization.

Also classify every station as:

- speed-cap limited;
- lateral-grip limited;
- acceleration limited;
- braking limited;
- switching;
- numerically unresolved.

## 18.5 Local geometry optimality

For the final coefficient vector, evaluate:

- all coordinate directions;
- selected local block directions;
- random smooth feasible directions.

Report the best discovered descent

$$
\Delta T_{\rm best\ direction}.
$$
A final candidate shall not be called locally polished if a tested perturbation improves lap time by more than the local-search tolerance.

## 18.6 Mesh convergence

Evaluate the final line at successively finer resolutions:

$$
N_s,\quad2N_s,\quad4N_s.
$$
Report

$$
T_{N_s},
\quad
T_{2N_s},
\quad
T_{4N_s}.
$$
Require

$$
|T_{4N_s}-T_{2N_s}|
\le
\varepsilon_{T,\rm mesh}.
$$
## 18.7 Basis convergence

Insert another knot-refinement level without changing the trajectory, then permit local refinement.

Report the resulting improvement

$$
\Delta T_{\rm basis}.
$$
If this remains significant, the previous spline basis was insufficiently expressive.

---

# 19. Output contract

The optimizer shall output:

## 19.1 Canonical trajectory

- periodic degree-5 spline coefficients for $d(u)$;
- auxiliary reference-spine identifier;
- actual path samples;
- tangent and yaw;
- curvature and curvature derivatives.

## 19.2 Speed profile

- $u_i$;
- actual arc length $\ell_i$;
- $v_i$;
- acceleration/braking command;
- acceleration-ellipse utilization;
- active limiting constraint.

## 19.3 Vehicle envelope

- all four vertex trajectories;
- nodal clearances;
- minimum continuous certified clearance.

## 19.4 Optimization provenance

- track hash;
- all vehicle settings;
- optimizer configuration;
- run mode;
- seed;
- GPU model;
- CUDA version;
- generation count;
- candidate counts;
- stage timing;
- acceptance rates;
- throughput metrics;
- mesh-convergence results.

## 19.5 Optional PH export

The periodic $C^4$ spline shall remain the canonical solution.

If a downstream system requires PH output:

1. fit a higher-regularity PH spline to the canonical trajectory;
2. match position, tangent, curvature, and preferably curvature rate;
3. recompute rectangle containment;
4. recompute the complete speed profile;
5. reject the conversion if lap-time or clearance degradation exceeds tolerance.

A $C^2$ PH conversion shall not automatically replace the canonical line because it may reintroduce curvature-rate discontinuities.

---

# 20. Software architecture

Recommended modules:

```text
track/
    ph_curve
    ph_offsets
    arc_length_map
    track_validator
    reference_spine_fit
    boundary_bvh
    safe_corridor

geometry/
    periodic_bspline
    trajectory_decoder
    curvature
    rectangle_vertices
    ribbon_query
    continuous_certificate

dynamics/
    aero_model
    acceleration_envelope
    speed_cap
    forward_backward_solver
    lap_time

optimizer/
    seed_generator
    island_es
    candidate_compaction
    hierarchical_refinement
    local_pattern_search
    smoothing_polish

cuda/
    basis_tables
    geometry_kernels
    containment_kernels
    speed_kernels
    ranking_kernels
    rng
    graph_executor

validation/
    cpu_reference
    mesh_convergence
    basis_convergence
    active_limit_report
    deterministic_replay

api/
    settings
    result
    telemetry
    serialization
```

The CPU reference implementation shall use the same formulas as the GPU implementation and shall be completed before aggressive CUDA optimization.

---

# 21. Implementation sequence

## Milestone 1 — CPU reference

Implement in FP64:

- PH track evaluation;
- offset boundaries;
- periodic spline;
- curvature derivatives;
- rectangle corners;
- exact containment;
- speed-profile solver;
- lap-time calculation.

Deliver analytic unit tests.

## Milestone 2 — GPU geometry evaluator

Implement:

- spline basis tables;
- batched trajectory decoding;
- curvature;
- corner transformation;
- fast ribbon queries;
- constraint masks.

Compare every kernel against the CPU reference.

## Milestone 3 — GPU speed solver

Implement:

- pointwise speed caps;
- forward/backward sweeps;
- cyclic convergence;
- lap-time reduction;
- active-limit diagnostics.

## Milestone 4 — Global population optimizer

Implement:

- counter-based RNG;
- islands;
- antithetic generation;
- feasible-first ranking;
- elite updates;
- restarts;
- CUDA Graph execution.

## Milestone 5 — Hierarchical and local refinement

Implement:

- exact knot insertion;
- adaptive feature indicators;
- batched pattern search;
- parent backtracking;
- near-optimal diversity retention.

## Milestone 6 — Continuous certification

Implement:

- certified boundary approximation;
- BVH queries;
- corner interval bounds;
- adaptive subdivision;
- FP64 final report.

---

# 22. Test requirements

## 22.1 Geometry unit tests

Test against:

- straight reference segments;
- circles;
- constant-offset circles;
- clothoid-like curvature ramps;
- periodic spline seam;
- known polynomial curves.

Verify analytic curvature and derivatives against symbolic or high-precision references.

## 22.2 Rectangle tests

Test:

- zero yaw;
- large relative yaw;
- contact at each of four vertices;
- constant-width circular lanes;
- varying-width lanes;
- seam crossing;
- close but nonintersecting track sections.

## 22.3 Dynamics tests

### Zero aero

Set

$$
C_DA=C_LA=0
$$
and compare with constant acceleration limits.

### Drag-only terminal speed

On a straight path, verify convergence toward the speed where

$$
a_{+,0}=a_D(v)
$$
when below the hard speed cap.

### Constant curvature

Verify the lateral cap analytically.

### Acceleration ellipse

For sampled $v,\kappa$, verify

$$
\left(
\frac{a_x}{A_x}
\right)^p
+
\left(
\frac{a_y}{A_y}
\right)^p
\le1.
$$
### Closed speed profile

Verify seam consistency and active-limit coverage.

## 22.4 GPU equivalence

For random feasible trajectories, compare GPU and CPU values for:

- position;
- derivatives;
- curvature;
- corner positions;
- lane slack;
- speed caps;
- propagated speed;
- lap time.

## 22.5 Determinism

Deterministic mode shall produce identical result bytes for repeated execution under the same build and hardware environment.

## 22.6 Stress tests

Include:

- narrow lanes;
- long tracks;
- thousands of PH segments;
- high downforce;
- zero downforce;
- $p=1$;
- $p=2$;
- large $p$;
- curvature-limit activation;
- blank curvature limit;
- very high maximum speed;
- near-empty rectangle-safe corridor.

---

# 23. Acceptance criteria

A release candidate is acceptable only if all of the following hold.

## Geometry

- Closure is structural.
- Position and derivatives through order four agree at the seam within FP64 evaluation tolerance.
- No regularity or progression violation occurs.
- No curvature, curvature-rate, or curvature-second-derivative jump occurs.

## Rectangle containment

- All four safety-expanded vertices pass exact nodal containment.
- Adaptive continuous certification passes every trajectory interval.
- Minimum conservative clearance is nonnegative.

## Dynamics

- Hard maximum speed is respected.
- The acceleration superellipse is respected.
- The optional curvature limit is respected.
- The periodic speed-profile residual is below tolerance.
- Every speed station has an active limiting mechanism within tolerance.

## Numerical convergence

- Lap time converges under mesh refinement.
- Further spline refinement produces no material improvement.
- Local pattern search finds no improvement above tolerance.

## Performance

After warm-up on RTX 4080:

- target at least $10^8$ candidate-station geometry evaluations per second for the coarse kernel;
- demonstrate millions of coarse proxy samples per second at appropriately low station count;
- report full-lap throughput as a function of $N_s$ and number of speed sweeps;
- maintain peak VRAM below 14 GB;
- maintain host orchestration below 5% of steady-state optimizer time;
- sustain a global geometric acceptance rate above 95%.

The first implementation shall treat these as benchmark targets. Final contractual numbers shall be set after profiling representative tracks with Nsight Compute.

---

# 24. Principal references

1. **R. T. Farouki, _Pythagorean-Hodograph Curves: Algebra and Geometry Inseparable_.** PH curves provide exact arc-length functions and rational offsets, which justifies retaining PH geometry as the authoritative track representation.

2. **M. Massaro and D. J. N. Limebeer, “Minimum-lap-time optimisation and simulation.”** Broad reference for quasi-steady and transient minimum-lap-time formulations, road models, $g$-$g$-$v$ envelopes, direct transcription, and the importance of smooth track-curvature data.

3. **N. R. Kapania, J. K. Subosits, and J. C. Gerdes, “A Sequential Two-Step Algorithm for Fast Generation of Vehicle Racing Trajectories.”** Relevant for forward/backward speed-profile construction, iterative path/speed optimization, minimum-curvature approximations, and explicit steering-slew constraints.

4. **H. Pham and Q.-C. Pham, “A New Approach to Time-Optimal Path Parameterization Based on Reachability Analysis.”** Canonical reference for robust backward controllable-set computation followed by forward maximum-speed selection.

5. **H. Xue et al., “Spline-Based Minimum-Curvature Trajectory Optimization for Autonomous Racing.”** Direct racing application of compact B-spline parameterization, local control, fixed continuity, and control-point optimization.

6. **NVIDIA, CUDA C++ Best Practices Guide.** Implementation guidance for coalesced memory, occupancy, precision, and verification.

7. **NVIDIA, CUDA Graphs and CUB documentation.** Relevant for recurring low-overhead execution graphs, candidate compaction, sorting, reduction, and batched segmented operations.

---

# 25. Confidence assessment

**Architecture and geometry representation: high.**

The combination of:

- authoritative PH track geometry;
- a smooth auxiliary reference spine;
- periodic quintic lateral fields;
- exact rectangle-corner evaluation;
- hierarchical B-spline refinement;
- and final continuous certification

directly addresses closure, sample acceptance, geometric expressiveness, and curvature discontinuities.

**Fixed-path speed solver: high.**

The spatial squared-speed formulation and cyclic forward/backward propagation are appropriate for the supplied quasi-steady acceleration-envelope model.

**Physical fidelity: moderate.**

The supplied settings do not include:

- engine power;
- gearing;
- rolling resistance;
- steering-rate limits;
- sideslip;
- transient tire response;
- load sensitivity;
- or front/rear force distribution.

The implementation shall therefore identify itself as a quasi-steady geometric and $g$-$g$-$v$ optimizer, not a full vehicle optimal-control model.

**Absolute throughput numbers: moderate until benchmarked.**

The proposed data layout and multi-fidelity pipeline are suitable for an RTX 4080, but full-candidate throughput depends strongly on track length, station count, boundary-query complexity, speed-solver iterations, and the proportion of candidates surviving each stage.