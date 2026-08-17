# GPU Minimum-Lap-Time Racing-Line Optimizer  
## Technical Specification — Version 2.0  
### Hybrid Fourier Backbone, Periodic B-Spline Residual, and Closure-Projected Curvature Optimization

**Status:** Implementation specification  
**Target hardware:** NVIDIA GeForce RTX 4080  
**Authoritative track representation:** closed planar PH centerline with two PH offset boundaries  
**Vehicle footprint:** safety-expanded rectangle  
**Primary objective:** minimum closed-lap traversal time  
**Supersedes:** Version 1.0 single-representation B-spline specification

---

# 0. Revision summary

Version 2.0 replaces the single periodic B-spline racing-line architecture with the intended four-layer architecture:

$$
\boxed{
\begin{aligned}
&\text{exact PH track and boundaries}\\
&+\ \text{smooth periodic Fourier kernel chart}\\
&+\ \text{global Fourier racing-line backbone}\\
&+\ \text{local periodic B-spline residual}\\
&+\ \text{closure-projected curvature-spline refinement}.
\end{aligned}
}
$$

The representations have distinct responsibilities:

1. **PH geometry** remains the exact source of track shape, arc length, and lane boundaries.
2. A **static Fourier kernel line** provides a $C^\infty$, closed, numerically well-conditioned coordinate spine.
3. A low-dimensional **Fourier lateral backbone** discovers global racing-line structure.
4. A compact-support **periodic B-spline residual** resolves local apexes, transitions, and track-specific imperfections.
5. A separate **intrinsic curvature representation** performs final minimum-time and curvature-quality refinement while satisfying closure through a small nonlinear projection.

The direct curvature representation is deliberately not used for unconstrained global random generation. Arbitrary curvature functions generally do not reconstruct to closed curves; published curvature-based curve-processing work explicitly identifies this closure issue.

Instead, direct curvature optimization begins from already feasible closed elites and uses a deterministic two- or three-constraint closure projector. This preserves the high acceptance rate required for GPU population optimization.

---

# 1. Objectives and design principles

The optimizer shall produce a trajectory

$$
\mathbf r:[0,1]\rightarrow\mathbb R^2
$$

and a periodic speed profile

$$
v:[0,1]\rightarrow\mathbb R_{>0}
$$

that minimize

$$
\boxed{
T=\oint_{\mathbf r}\frac{d\ell}{v}
}
$$

subject to the supplied vehicle, aerodynamic, grip, curvature, speed, and track-containment constraints.

The implementation shall satisfy the following architectural principles.

## 1.1 Closure is structural

Global and intermediate candidates shall be closed because all geometric basis functions are periodic.

Final curvature-space candidates shall be closed by a deterministic closure-projection solve.

No optimization stage shall rely on a soft endpoint-distance penalty such as

$$
\|\mathbf r(1)-\mathbf r(0)\|^2.
$$

## 1.2 Global and local geometric scales are separated

The Fourier component shall control long-wavelength structure:

- general corner approach;
- exit positioning;
- allocation of track width;
- interaction between neighboring corners;
- gross path-length versus curvature trade-offs.

The periodic B-spline component shall control local structure:

- apex location;
- local entry/exit asymmetry;
- chicane transitions;
- narrow geometric corrections;
- elimination of small local lap-time defects.

The two bases shall be algebraically separated to avoid redundant degrees of freedom.

## 1.3 Curvature is explicitly modeled

Curvature shall not be treated only as a derived visualization quantity.

The optimizer shall:

- evaluate curvature analytically;
- evaluate curvature derivatives analytically;
- bound or penalize unresolved curvature variation;
- adapt geometric resolution where curvature requires it;
- perform a final intrinsic curvature-spline optimization.

## 1.4 High acceptance is obtained by decoding and repair

The optimizer shall not generate arbitrary Cartesian curves and reject almost all of them.

Candidate generation shall use:

- periodic bases;
- a rectangle-safe center corridor;
- frequency-limited perturbations;
- feasible-parent interpolation;
- closure projection;
- trust-region backtracking.

## 1.5 Throughput metrics are explicit

“Samples per second” shall be reported separately as:

$$
R_{\rm station}
=
\frac{\text{candidate-station evaluations}}{\text{s}},
$$

$$
R_{\rm proxy}
=
\frac{\text{coarse candidate scores}}{\text{s}},
$$

$$
R_{\rm full}
=
\frac{\text{complete speed-profile evaluations}}{\text{s}},
$$

$$
R_{\rm curvature}
=
\frac{\text{closure-projected curvature candidates}}{\text{s}},
$$

$$
R_{\rm certified}
=
\frac{\text{continuously certified trajectories}}{\text{s}}.
$$

Millions of coarse candidates per second may be a valid target at low station counts. Millions of high-resolution, dynamically solved, continuously certified complete laps per second shall not be used as a contractual requirement.

The desktop RTX 4080 has 9,728 CUDA cores and 16 GB GDDR6X memory, providing sufficient outer parallelism for very large candidate batches.

---

# 2. Public input contract

The optimizer shall accept all settings shown in the supplied interface.

| Setting | Symbol | Default | Unit | Interpretation |
|---|---:|---:|---:|---|
| Vehicle mass | $m$ | $900$ | kg | Mass used for drag and downforce acceleration |
| Rectangle length | $L_{\rm car}$ | $4.8$ | m | Physical vehicle footprint length |
| Rectangle width | $W_{\rm car}$ | $2.0$ | m | Physical vehicle footprint width |
| Safety margin | $m_s$ | $0.05$ | m per side | Added to every side of the rectangle |
| Maximum speed | $v_{\max}$ | $91.6667$ | m/s | Hard speed limit |
| Base acceleration | $a_{+,0}$ | $6$ | m/s² | Zero-aerodynamic-load forward capability |
| Base braking | $a_{-,0}$ | $14$ | m/s² | Zero-aerodynamic-load braking capability |
| Base lateral grip | $a_{y,0}$ | $15$ | m/s² | Zero-aerodynamic-load lateral capability |
| Acceleration ellipse exponent | $p$ | $2$ | dimensionless | Combined-force superellipse exponent |
| Drag area | $C_DA$ | $1$ | m² | Quadratic aerodynamic drag parameter |
| Downforce area | $C_LA$ | $3$ | m² | Quadratic aerodynamic downforce parameter |
| Air density | $\rho$ | $1.225$ | kg/m³ | Atmospheric density |
| Curvature limit | $\kappa_{\max}$ | blank | 1/m | Blank disables the geometric limit |
| Run mode | — | Nondeterministic | — | Reproducible or fresh random sequence |

Validation requirements:

$$
m>0,
\quad
L_{\rm car}>0,
\quad
W_{\rm car}>0,
$$

$$
v_{\max}>0,
\quad
a_{+,0}>0,
\quad
a_{-,0}>0,
\quad
a_{y,0}>0,
$$

$$
m_s\ge0,
\quad
C_DA\ge0,
\quad
C_LA\ge0,
\quad
\rho>0,
\quad
p\ge1.
$$

A nonblank curvature limit shall satisfy

$$
\kappa_{\max}>0.
$$

## 2.1 Explicitly absent parameters

The current input set contains no:

- engine power curve;
- gear ratios;
- rolling resistance;
- steering-rate limit;
- tire relaxation length;
- load-sensitivity curve;
- front/rear grip distribution;
- sideslip model.

Version 2.0 shall not silently invent these quantities.

The resulting dynamics model is a quasi-steady speed-dependent acceleration-envelope model.

---

# 3. Vehicle rectangle

The safety-expanded half-length and half-width are

$$
\boxed{
a=\frac{L_{\rm car}}{2}+m_s
}
$$

and

$$
\boxed{
b=\frac{W_{\rm car}}{2}+m_s.
}
$$

For the supplied defaults,

$$
a=2.45\ {\rm m},
\qquad
b=1.05\ {\rm m}.
$$

The corner radius is

$$
\boxed{
\rho_{\rm car}=\sqrt{a^2+b^2}.
}
$$

For the default vehicle,

$$
\rho_{\rm car}\approx2.66552\ {\rm m}.
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

If the vehicle-center trajectory is $\mathbf r(u)$ and body yaw is $\psi(u)$, the world-space vertices are

$$
\boxed{
\mathbf V_{\epsilon,\eta}(u)
=
\mathbf r(u)
+
R(\psi(u))
\mathbf q_{\epsilon,\eta},
}
$$

where

$$
R(\psi)
=
\begin{bmatrix}
\cos\psi&-\sin\psi\\
\sin\psi&\cos\psi
\end{bmatrix}.
$$

Version 2.0 assumes

$$
\psi(u)
=
\operatorname{atan2}
\left(
y_u(u),x_u(u)
\right),
$$

so vehicle yaw equals trajectory tangent yaw.

The code shall permit a future body-sideslip extension

$$
\psi_{\rm body}
=
\psi_{\rm tangent}+\beta_{\rm body}
$$

without changing the corner-containment subsystem.

---

# 4. Authoritative PH track representation

Let the closed PH centerline be

$$
\mathbf c_{\rm PH}(s),
\qquad
s\in[0,L_{\rm PH}),
$$

where $s$ is centerline arc length.

The corresponding tangent, normal, and curvature are

$$
\mathbf t_{\rm PH}(s),
\qquad
\mathbf n_{\rm PH}(s),
\qquad
\kappa_{\rm PH}(s).
$$

The legal lane boundaries are the two PH offsets

$$
\boxed{
\mathbf b_L(s)
=
\mathbf c_{\rm PH}(s)
+
w_L(s)\mathbf n_{\rm PH}(s)
}
$$

and

$$
\boxed{
\mathbf b_R(s)
=
\mathbf c_{\rm PH}(s)
-
w_R(s)\mathbf n_{\rm PH}(s).
}
$$

For constant-width tracks, $w_L$ and $w_R$ are constants.

PH curves are appropriate as the authoritative track model because they permit exact polynomial arc-length functions and rational offset representations.

## 4.1 Required PH validation

Preprocessing shall reject a track if any of the following holds:

- the centerline is not regular;
- the centerline is not position-periodic;
- tangent orientation is inconsistent at closure;
- either offset contains a cusp;
- either offset self-intersects;
- left and right offsets intersect;
- the lane has zero or negative local width;
- the lane does not form one simple annular region;
- track correspondence becomes ambiguous.

For a regular normal offset, require

$$
1-\kappa_{\rm PH}(s)d>0
$$

throughout the legal local offset range.

This local condition is necessary but not sufficient. A global self-intersection test is also required.

## 4.2 Exact versus accelerated evaluation

The implementation shall provide two boundary evaluators:

### Fast evaluator

Used for population screening:

- equal-arc-length lookup table;
- cubic or quintic interpolation;
- precomputed boundary segments;
- conservative signed-distance texture or BVH;
- bounded approximation error.

### Exact evaluator

Used for elites and certification:

- exact PH segment evaluation;
- exact or certified rational-offset evaluation;
- safeguarded nearest-point solve;
- double-precision containment.

The fast evaluator shall include an inward error margin so it cannot declare a geometrically invalid corner safe because of interpolation error.

---

# 5. Static Fourier kernel chart

The optimizer shall not use the potentially only $C^2$ PH centerline directly as the differentiable carrier of the racing-line field.

Instead, preprocessing shall construct a smooth periodic coordinate chart.

## 5.1 Fourier kernel spine

Define normalized track coordinate

$$
u=\frac{s}{L_{\rm PH}}\in[0,1).
$$

The Fourier kernel spine is

$$
\boxed{
\mathbf c_K(u)
=
\mathbf a_0
+
\sum_{k=1}^{K_K}
\left[
\mathbf a_k\cos(2\pi ku)
+
\mathbf b_k\sin(2\pi ku)
\right].
}
$$

It is periodic and $C^\infty$.

The coefficient fit shall minimize

$$
J_K
=
\sum_j
\omega_j
\left\|
\mathbf c_K(u_j)
-
\mathbf c_{\rm PH}(L_{\rm PH}u_j)
\right\|^2
+
\lambda_K
\sum_{k=1}^{K_K}
k^{2r_K}
\left(
\|\mathbf a_k\|^2+\|\mathbf b_k\|^2
\right).
$$

Recommended:

$$
r_K=3\text{ or }4.
$$

The mode count $K_K$ shall increase adaptively until:

- geometric fit error is below tolerance;
- curvature fit is adequate for coordinate construction;
- the kernel line is regular;
- the required safe corridor is covered;
- the chart remains injective.

The Fourier kernel line is not the racing trajectory and is not the legal-boundary authority.

Fourier descriptions of accumulated tangent direction and closed planar curves are classical and naturally separate long-wavelength from short-wavelength shape information.

## 5.2 Smooth transverse field

The default transverse vector field is the unit normal of the kernel spine:

$$
\mathbf g_K(u)=\mathbf n_K(u).
$$

For tracks where normal rays are poorly conditioned, preprocessing may instead fit a smooth periodic transverse field

$$
\mathbf g_K(u)
$$

to synchronized left-right lane gates.

Requirements:

$$
\|\mathbf g_K(u)\|=1,
$$

$$
\mathbf g_K(0)=\mathbf g_K(1),
$$

and the chart Jacobian shall remain bounded away from zero.

## 5.3 Kernel chart

The default chart is

$$
\boxed{
\Phi(u,d)
=
\mathbf c_K(u)+d\mathbf g_K(u).
}
$$

For a normal chart,

$$
\Phi(u,d)
=
\mathbf c_K(u)+d\mathbf n_K(u).
$$

Its local Jacobian is

$$
J_\Phi(u,d)
=
\det
\left(
\frac{\partial\Phi}{\partial u},
\frac{\partial\Phi}{\partial d}
\right).
$$

Require

$$
\boxed{
|J_\Phi(u,d)|\ge J_{\min}>0
}
$$

over the complete optimizer corridor.

Preprocessing shall also verify global injectivity numerically.

If one global chart is not valid, the implementation shall support multiple overlapping periodic chart regions or a fitted gate-based transverse field. It shall not force a singular normal chart through problematic geometry.

---

# 6. Rectangle-safe center corridors

The global generator shall operate inside a corridor designed for the complete rectangle, not merely the vehicle center.

## 6.1 Heading-conditioned feasible interval

At kernel coordinate $u$, center displacement $d$, and body heading offset $\beta$, define

$$
\mathbf p(u,d)=\Phi(u,d)
$$

and

$$
\psi_{\rm body}
=
\psi_K(u)+\beta.
$$

For every sampled $(u,\beta)$, compute

$$
\mathcal D(u,\beta)
=
\left\{
d:
\mathbf V_{\epsilon,\eta}(u,d,\beta)
\in\Omega_{\rm track}
\quad
\forall\epsilon,\eta
\right\}.
$$

For a valid track chart, this set should normally be one interval:

$$
\boxed{
\mathcal D(u,\beta)
=
[
d_-(u,\beta),
d_+(u,\beta)
].
}
$$

If it is disconnected, the preprocessor shall report an invalid or ambiguous chart.

The interval shall be computed against the authoritative PH lane.

## 6.2 Robust global corridor

Select an admissible global relative-yaw range

$$
|\beta|\le\beta_{\rm safe}.
$$

Define

$$
d_-^{\rm robust}(u)
=
\max_{|\beta|\le\beta_{\rm safe}}
d_-(u,\beta),
$$

$$
d_+^{\rm robust}(u)
=
\min_{|\beta|\le\beta_{\rm safe}}
d_+(u,\beta).
$$

Fit smooth periodic inward approximations:

$$
\underline d_G(u)
\ge
d_-^{\rm robust}(u),
$$

$$
\overline d_G(u)
\le
d_+^{\rm robust}(u).
$$

The fitting process shall include margins for:

- heading-grid interpolation;
- PH lookup error;
- boundary approximation error;
- floating-point error.

The initial global search shall remain within

$$
\boxed{
\underline d_G(u)
\le d(u)\le
\overline d_G(u).
}
$$

## 6.3 Local full-width corridor

For local optimization, use the less conservative heading-conditioned constraint

$$
d_-(u,\beta(u))
\le d(u)\le
d_+(u,\beta(u)).
$$

This constraint shall be evaluated rather than embedded pointwise into the curve decoder. Keeping it as a smooth inequality avoids introducing table interpolation noise directly into the geometric representation.

## 6.4 Corridor homotopy

The optimization corridor shall expand gradually:

$$
\underline d_\lambda
=
(1-\lambda)
\underline d_G
+
\lambda
\underline d_L,
$$

$$
\overline d_\lambda
=
(1-\lambda)
\overline d_G
+
\lambda
\overline d_L,
$$

where

$$
0\le\lambda\le1.
$$

Early global generations use

$$
\lambda=0.
$$

Late local generations approach

$$
\lambda=1
$$

and rely on exact rectangle checking and feasible-parent repair.

---

# 7. Discovery representation: Fourier backbone plus local B-spline residual

The principal global and intermediate racing-line representation shall be

$$
\boxed{
\mathbf r(u)=\Phi(u,d(u)).
}
$$

The scalar lateral field $d(u)$ shall be generated by a hybrid periodic basis.

## 7.1 Global Fourier backbone

Define

$$
z_F(u)
=
q_0+
\sum_{k=1}^{K_F}
\left[
q_k^{c}\cos(2\pi ku)
+
q_k^{s}\sin(2\pi ku)
\right].
$$

The Fourier backbone discovers global features.

The physical wavelength of mode $k$ is approximately

$$
\lambda_k=\frac{L_{\rm PH}}{k}.
$$

Initial mode counts shall therefore be selected by physical scale, not by an arbitrary fixed number.

For example:

$$
K_F^{(0)}
=
\left\lfloor
\frac{L_{\rm PH}}{150\ {\rm m}}
\right\rfloor,
$$

followed by continuation toward

$$
K_F^{\max}
=
\left\lfloor
\frac{L_{\rm PH}}{30\text{--}50\ {\rm m}}
\right\rfloor.
$$

Minimum and maximum mode counts shall be configurable.

## 7.2 Local periodic B-spline residual

Use a periodic quintic B-spline basis

$$
B_j^{(5)}(u),
\qquad
j=0,\ldots,N_B-1.
$$

Define the raw local field

$$
\tilde z_B(u)
=
\sum_j c_jB_j^{(5)}(u).
$$

With simple cyclic knots,

$$
\tilde z_B\in C^4.
$$

The B-spline residual shall be hierarchical, with local knot spacing progressively refined.

Recommended physical knot spacing sequence:

$$
80\ {\rm m}
\rightarrow
40\ {\rm m}
\rightarrow
20\ {\rm m}
\rightarrow
10\ {\rm m}
\rightarrow
5\ {\rm m}.
$$

Not every track requires the finest level everywhere.

## 7.3 Removal of basis redundancy

The B-spline residual shall not duplicate the low-frequency Fourier subspace.

Let $F$ be the sampled Fourier basis matrix, $B$ the sampled B-spline basis matrix, and $W$ the quadrature-weight matrix.

Define

$$
P_F
=
F(F^\mathsf TWF)^{-1}F^\mathsf TW.
$$

The high-pass local residual is

$$
\boxed{
z_B=(I-P_F)Bc.
}
$$

For efficient implementation,

$$
z_B
=
Bc-FGc,
$$

where

$$
G
=
(F^\mathsf TWF)^{-1}F^\mathsf TWB.
$$

Thus B-spline evaluation remains local plus a small low-rank Fourier correction.

The complete latent field is

$$
\boxed{
z(u)=z_F(u)+z_B(u).
}
$$

This separation improves conditioning and gives each representation a distinct optimization role.

## 7.4 Bounded decoder

Define the robust-corridor midpoint and half-width:

$$
m_G(u)
=
\frac{
\underline d_G(u)+\overline d_G(u)
}{2},
$$

$$
h_G(u)
=
\frac{
\overline d_G(u)-\underline d_G(u)
}{2}.
$$

Use the bounded map

$$
\eta(u)=\tanh z(u).
$$

Then

$$
\boxed{
d(u)=m_G(u)+h_G(u)\eta(u).
}
$$

Therefore every decoded global candidate satisfies

$$
\underline d_G(u)<d(u)<\overline d_G(u)
$$

for every continuous $u$.

To avoid excessive saturation, the optimizer shall maintain most latent values inside

$$
|z|\lesssim2.
$$

Large coefficients shall be rescaled or reflected rather than allowed to produce numerically flat $\tanh$ regions.

## 7.5 Closure and smoothness

All basis functions and the kernel chart are periodic, so

$$
\mathbf r(0)=\mathbf r(1).
$$

The periodic derivative conditions hold automatically through the continuity order of the least-smooth component.

Because

$$
z_F\in C^\infty,
\qquad
z_B\in C^4,
\qquad
\Phi\in C^\infty,
$$

the discovery trajectory satisfies

$$
\boxed{
\mathbf r\in C^4.
}
$$

For a regular planar trajectory,

$$
\boxed{
\kappa\in C^2.
}
$$

Thus there can be no jumps in:

$$
\kappa,
\qquad
\frac{d\kappa}{d\ell},
\qquad
\frac{d^2\kappa}{d\ell^2}.
$$

The use of compact B-spline control variables for smooth racing-line optimization is consistent with prior autonomous-racing work demonstrating substantial dimensionality reduction while retaining geometric smoothness.

## 7.6 Analytic derivatives

For the generic chart,

$$
\mathbf r_u
=
\Phi_u+\Phi_d d_u,
$$

$$
\mathbf r_{uu}
=
\Phi_{uu}
+
2\Phi_{ud}d_u
+
\Phi_{dd}d_u^2
+
\Phi_d d_{uu}.
$$

For the linear transverse chart

$$
\Phi(u,d)=\mathbf c_K(u)+d\mathbf g_K(u),
$$

$$
\mathbf r_u
=
\mathbf c_K'
+
d'\mathbf g_K
+
d\mathbf g_K',
$$

$$
\mathbf r_{uu}
=
\mathbf c_K''
+
d''\mathbf g_K
+
2d'\mathbf g_K'
+
d\mathbf g_K''.
$$

All derivatives through the order required for

$$
\kappa_{\ell\ell}
$$

shall be evaluated analytically from precomputed Fourier and B-spline derivative bases.

Finite differences of sampled $x,y$ coordinates shall not be used for production curvature evaluation.

## 7.7 Normal-chart specialization

If the kernel line is arc-length parameterized and

$$
\mathbf r(s)
=
\mathbf c_K(s)+d(s)\mathbf n_K(s),
$$

define

$$
A=1-\kappa_Kd,
\qquad
B=d_s.
$$

Then

$$
\mathbf r_s=A\mathbf t_K+B\mathbf n_K,
$$

$$
\boxed{
\frac{d\ell}{ds}
=
q=
\sqrt{A^2+B^2}.
}
$$

The trajectory curvature is

$$
\boxed{
\kappa
=
\frac{
\kappa_KA^2
+
A d_{ss}
+
\kappa_{K,s}dd_s
+
2\kappa_Kd_s^2
}{
(A^2+d_s^2)^{3/2}
}.
}
$$

The relative tangent angle is

$$
\boxed{
\beta
=
\operatorname{atan2}
\left(
d_s,
1-\kappa_Kd
\right).
}
$$

These formulas shall be used in the optimized normal-chart kernel.

## 7.8 Regularity and progression constraints

Require

$$
\|\mathbf r_u\|\ge q_{\min}>0.
$$

Also require positive progression through the track chart:

$$
\boxed{
\mathbf r_u\cdot\mathbf c_K'(u)
\ge
\tau_{\rm progress}
\|\mathbf r_u\|
\|\mathbf c_K'(u)\|.
}
$$

This prevents:

- local reversals;
- loops;
- parameterization collapse;
- ambiguous lane assignment.

---

# 8. Explicit curvature representation

The final optimization stage shall use an intrinsic curvature representation.

This stage is not optional in Version 2.0 unless explicitly disabled for diagnostic comparison.

## 8.1 Normalized arc-length coordinate

Let

$$
\tau=\frac{\ell}{L},
\qquad
\tau\in[0,1),
$$

where $L$ is the trajectory length.

Define dimensionless curvature

$$
\boxed{
K(\tau)=L\kappa(\ell).
}
$$

The tangent angle satisfies

$$
\frac{d\theta}{d\tau}=K(\tau).
$$

The trajectory satisfies

$$
\frac{d\mathbf r}{d\tau}
=
L
\begin{bmatrix}
\cos\theta\\
\sin\theta
\end{bmatrix}.
$$

## 8.2 Hybrid curvature field

Starting from a feasible elite $K_*(\tau)$, represent a perturbation as

$$
K(\tau)
=
K_*(\tau)
+
\delta K_F(\tau)
+
\delta K_B(\tau)
+
\sum_{j=0}^{2}\lambda_j\phi_j(\tau).
$$

The free Fourier curvature component is

$$
\delta K_F
=
a_0+
\sum_{k=1}^{K_\kappa}
\left[
a_k\cos(2\pi k\tau)
+
b_k\sin(2\pi k\tau)
\right].
$$

The local curvature component is a periodic quintic B-spline residual:

$$
\delta K_B
=
\sum_j c_j^\kappa B_j^{(5)}(\tau),
$$

projected away from the Fourier curvature subspace in the same manner as Section 7.3.

The curvature correction modes

$$
\phi_0,\phi_1,\phi_2
$$

are reserved exclusively for closure projection and are not free optimizer variables.

## 8.3 Curvature smoothness

With a periodic quintic curvature residual,

$$
K\in C^4.
$$

Therefore

$$
\kappa=\frac KL\in C^4,
$$

$$
\theta\in C^5,
$$

and the reconstructed trajectory satisfies

$$
\boxed{
\mathbf r\in C^6.
}
$$

This final representation is substantially smoother than the minimum required to prevent curvature jumps.

Increasing spline degree beyond this shall require a measured numerical or physical benefit. $C^8$ geometry shall not be used merely as a generic smoothness setting.

---

# 9. Curvature-space closure projector

A periodic curvature function does not automatically reconstruct to a closed curve. The optimizer shall explicitly solve the closure conditions.

## 9.1 Closure residuals

Define

$$
\theta(\tau)
=
\theta_0+
\int_0^\tau K(\xi)d\xi.
$$

For winding number

$$
\nu\in\{-1,+1\},
$$

define

$$
C_0
=
\int_0^1K(\tau)d\tau
-
2\pi\nu,
$$

$$
C_x
=
\int_0^1\cos\theta(\tau)d\tau,
$$

$$
C_y
=
\int_0^1\sin\theta(\tau)d\tau.
$$

The required closure system is

$$
\boxed{
\mathbf C
=
\begin{bmatrix}
C_0\\
C_x\\
C_y
\end{bmatrix}
=
\mathbf0.
}
$$

The first equation closes tangent orientation.

The second and third equations close position.

## 9.2 Closure-correction modes

Use

$$
\phi_0(\tau)=1
$$

for total-turn correction.

Choose $\phi_1,\phi_2$ from a bank containing:

- low Fourier modes;
- broad periodic B-spline modes;
- spatially separated smooth localized modes.

The pair shall be selected for good Jacobian conditioning at the parent trajectory.

## 9.3 Analytic closure Jacobian

Define

$$
\Phi_j(\tau)
=
\int_0^\tau\phi_j(\xi)d\xi.
$$

Then

$$
\frac{\partial C_0}{\partial\lambda_j}
=
\int_0^1\phi_j(\tau)d\tau,
$$

$$
\frac{\partial C_x}{\partial\lambda_j}
=
-
\int_0^1
\sin\theta(\tau)
\Phi_j(\tau)
d\tau,
$$

$$
\frac{\partial C_y}{\partial\lambda_j}
=
\int_0^1
\cos\theta(\tau)
\Phi_j(\tau)
d\tau.
$$

Thus

$$
J_C
=
\frac{\partial\mathbf C}
{\partial\boldsymbol\lambda}
$$

is a $3\times3$ matrix.

## 9.4 Damped Newton projection

For each candidate, initialize

$$
\boldsymbol\lambda=\mathbf0
$$

or the parent correction.

Repeat:

$$
J_C\Delta\boldsymbol\lambda
=
-\mathbf C,
$$

$$
\boldsymbol\lambda
\leftarrow
\boldsymbol\lambda
+
\alpha\Delta\boldsymbol\lambda,
$$

with

$$
0<\alpha\le1
$$

selected by residual-reducing line search.

Terminate when

$$
\|\mathbf C\|_\infty
\le\varepsilon_{\rm close}.
$$

Global FP32 curvature screening may use

$$
\varepsilon_{\rm close}\sim10^{-5}.
$$

Final FP64 certification shall use a substantially tighter tolerance, normally

$$
\varepsilon_{\rm close}\le10^{-10}.
$$

## 9.5 Conditioning test

Reject or backtrack a curvature perturbation when

$$
\operatorname{cond}(J_C)
>
\kappa_{J,\max}.
$$

The implementation shall attempt another correction-mode pair before rejecting.

## 9.6 Homotopy fallback

Because the parent trajectory is closed, closure convergence can be protected through perturbation homotopy.

For proposed free perturbation $\delta K$, attempt

$$
K_\alpha=K_*+\alpha\delta K,
$$

with

$$
\alpha=1,\frac12,\frac14,\ldots.
$$

At

$$
\alpha=0,
$$

the parent is exactly closed.

Therefore sufficiently small accepted perturbations should remain inside the local domain where the closure projection is well conditioned.

This is the main reason direct curvature optimization is used as a local elite stage rather than as the first global generator.

## 9.7 Curve reconstruction

After closure projection, define an intrinsic unit-length curve

$$
\tilde{\mathbf r}(\tau)
=
\int_0^\tau
\begin{bmatrix}
\cos\theta(\xi)\\
\sin\theta(\xi)
\end{bmatrix}
d\xi.
$$

Because

$$
C_x=C_y=0,
$$

$$
\tilde{\mathbf r}(1)
=
\tilde{\mathbf r}(0).
$$

The physical curve is

$$
\boxed{
\mathbf r(\tau)
=
\mathbf t
+
R(\varphi)
L\tilde{\mathbf r}(\tau).
}
$$

The variables are:

- total length $L$;
- rigid rotation $\varphi$;
- translation $\mathbf t$.

## 9.8 Alignment to parent trajectory

For every curvature candidate, determine $\varphi$ and $\mathbf t$ through weighted two-dimensional Procrustes alignment to the parent elite.

The scale $L$ shall be an explicit trust-region variable:

$$
L=L_*\exp(\delta_L),
$$

with

$$
|\delta_L|\le\Delta_L.
$$

The alignment shall not change closure or curvature.

A small cyclic phase shift may also be optimized:

$$
\tau\mapsto\tau+\delta_\tau\pmod1.
$$

The start/finish seam should be placed on a relatively straight, low-sensitivity portion of the circuit. Multiple phase-shifted curvature polishes may be run to test seam bias.

## 9.9 Canonical status

After successful curvature-space optimization, the closure-projected curvature representation shall become the authoritative final trajectory representation.

The Fourier-plus-B-spline lateral representation shall remain available as:

- the discovery representation;
- a compact track-coordinate approximation;
- a restart seed;
- a visualization/export form.

If the final curvature path is fitted back to the lateral representation, the fit must be revalidated dynamically and geometrically.

---

# 10. Continuous rectangle containment

The hard condition is

$$
\boxed{
\mathbf V_{\epsilon,\eta}(u)
\in\Omega_{\rm track}
\quad
\forall u,\epsilon,\eta.
}
$$

Nodal checking alone is insufficient.

## 10.1 Fast nodal check

For each candidate station:

1. evaluate trajectory position;
2. evaluate tangent yaw;
3. transform all four rectangle vertices;
4. query each vertex against the conservative fast track representation;
5. record minimum signed clearance.

Define

$$
D_\Omega(\mathbf x)>0
$$

inside the legal lane.

The nodal margin is

$$
m_i
=
\min_{\epsilon,\eta}
D_\Omega
\left(
\mathbf V_{\epsilon,\eta}(u_i)
\right).
$$

Require

$$
m_i\ge0.
$$

## 10.2 Continuous corner-motion bound

Parameterize the candidate by its actual arc length $\ell$.

For one corner,

$$
\mathbf V(\ell)
=
\mathbf r(\ell)+R(\psi(\ell))\mathbf q.
$$

Since

$$
\frac{d\psi}{d\ell}=\kappa,
$$

$$
\frac{d\mathbf V}{d\ell}
=
\mathbf T
+
\kappa R(\psi)J\mathbf q.
$$

Therefore

$$
\boxed{
\left\|
\frac{d\mathbf V}{d\ell}
\right\|
\le
1+\rho_{\rm car}|\kappa|.
}
$$

For an interval $I$ centered at $\ell_m$, with half-length $h_I$, and curvature bound

$$
|\kappa|\le\kappa_{I,\max},
$$

the maximum corner displacement from the midpoint is bounded by

$$
\Delta_I
=
\left(
1+\rho_{\rm car}\kappa_{I,\max}
\right)h_I.
$$

Since signed Euclidean distance is 1-Lipschitz, the complete interval is safe if

$$
\boxed{
D_\Omega
\left(
\mathbf V(\ell_m)
\right)
>
\Delta_I
+
\varepsilon_{\rm boundary}
+
\varepsilon_{\rm cert}.
}
$$

If not, subdivide the interval.

## 10.3 Final certification

Final certification shall recursively subdivide every unresolved interval until:

- the interval is certified safe;
- an actual violation is found;
- or the minimum interval length is reached.

At minimum interval length, use a stronger interval, Bernstein, or dense exact test.

A final trajectory shall not be marked valid merely because all discretization nodes are valid.

---

# 11. Curvature evaluation and anti-alias protection

A smooth representation can still contain a narrow curvature peak between evaluation stations.

## 11.1 Curvature formula

For a generic parameter $u$,

$$
\boxed{
\kappa(u)
=
\frac{
x_uy_{uu}-y_ux_{uu}
}{
\left(
x_u^2+y_u^2
\right)^{3/2}
}.
}
$$

Actual arc-length differentiation is

$$
\frac{d}{d\ell}
=
\frac1{\|\mathbf r_u\|}
\frac{d}{du}.
$$

Thus

$$
\kappa_\ell
=
\frac{\kappa_u}{\|\mathbf r_u\|}.
$$

The second derivative is

$$
\kappa_{\ell\ell}
=
\frac{\kappa_{uu}}{\|\mathbf r_u\|^2}
-
\frac{
\kappa_u
\frac{d}{du}\|\mathbf r_u\|
}{
\|\mathbf r_u\|^3
}.
$$

## 11.2 Conservative interval curvature bound

For interval $I=[a,b]$, with midpoint $m$ and half-length $h$,

$$
|\kappa(\ell)|
\le
|\kappa(m)|
+
h
\sup_{\ell\in I}
|\kappa_\ell(\ell)|.
$$

A practical bound is

$$
\boxed{
\kappa_{I,\max}
=
\max_{j\in Q_I}|\kappa_j|
+
h_I
\max_{j\in Q_I}|\kappa_{\ell,j}|
+
\varepsilon_{\kappa,I},
}
$$

where $Q_I$ is a Gauss-Lobatto sample set.

The speed solver shall use this conservative bound whenever an interval is too coarse to guarantee that the sampled curvature maximum is resolved.

## 11.3 Refinement triggers

Subdivide or insert a local knot when any of the following exceeds its threshold:

$$
|\kappa_\ell|,
$$

$$
|\kappa_{\ell\ell}|,
$$

$$
\Delta\kappa_I,
$$

$$
\Delta v_I,
$$

$$
\Delta a_y,
$$

$$
\text{corner-clearance uncertainty},
$$

$$
\text{active-constraint transition density}.
$$

## 11.4 Curvature regularizer

Define characteristic vehicle length

$$
L_e=L_{\rm car}+2m_s.
$$

Use the dimensionless roughness functional

$$
\boxed{
R_\kappa
=
\frac1L
\int_0^L
\left[
\left(
L_e^2\kappa_\ell
\right)^2
+
\eta_\kappa
\left(
L_e^3\kappa_{\ell\ell}
\right)^2
\right]
d\ell.
}
$$

This shall be used as:

- a tie-breaker during global search;
- a weak regularizer during local search;
- the primary objective during the final minimum-time-preserving smoothing stage.

It shall not be assigned a fixed weight large enough to obscure actual lap-time differences.

## 11.5 Lateral jerk diagnostic

With

$$
a_y=v^2\kappa,
$$

$$
\boxed{
j_y
=
2va_x\kappa
+
v^3\kappa_\ell.
}
$$

Report:

$$
\max|j_y|
$$

and

$$
\operatorname{RMS}(j_y).
$$

No hard lateral-jerk constraint shall be inferred from the current public inputs.

---

# 12. Vehicle dynamics

Let

$$
g=9.80665\ {\rm m/s^2}.
$$

## 12.1 Drag

$$
F_D(v)
=
\frac12\rho C_DA\,v^2.
$$

$$
\boxed{
a_D(v)
=
\frac{\rho C_DA}{2m}v^2.
}
$$

## 12.2 Downforce

$$
F_L(v)
=
\frac12\rho C_LA\,v^2.
$$

Define normal-load multiplier

$$
\boxed{
\chi(v)
=
1+
\frac{
\rho C_LA
}{
2mg
}v^2.
}
$$

## 12.3 Speed-dependent capacities

$$
A_+(v)=a_{+,0}\chi(v),
$$

$$
A_-(v)=a_{-,0}\chi(v),
$$

$$
A_y(v)=a_{y,0}\chi(v).
$$

## 12.4 Lateral acceleration

$$
\boxed{
a_y=v^2\kappa.
}
$$

Define lateral utilization

$$
r_y
=
\frac{|v^2\kappa|}{A_y(v)}.
$$

If

$$
r_y>1,
$$

the speed-curvature state is infeasible.

## 12.5 Combined-force superellipse

For forward tire acceleration,

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

For braking tire acceleration magnitude,

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
a_{x,+}^{\rm tire}
=
A_+(v)
\left[
1-r_y^p
\right]_+^{1/p},
$$

$$
a_{x,-}^{\rm tire}
=
A_-(v)
\left[
1-r_y^p
\right]_+^{1/p}.
$$

The net forward acceleration is

$$
\boxed{
a_{\max}(v,\kappa)
=
a_{x,+}^{\rm tire}
-
a_D(v).
}
$$

The maximum net braking magnitude is

$$
\boxed{
b_{\max}(v,\kappa)
=
a_{x,-}^{\rm tire}
+
a_D(v).
}
$$

For the common case

$$
p=2,
$$

the GPU kernel shall use a specialized square-root implementation.

## 12.6 Hard maximum speed

$$
\boxed{
v\le v_{\max}.
}
$$

## 12.7 Optional curvature limit

When enabled,

$$
\boxed{
|\kappa|\le\kappa_{\max}.
}
$$

---

# 13. Pointwise speed cap

Let

$$
w=v^2.
$$

The pure-lateral condition is

$$
w|\kappa|
\le
a_{y,0}
\left(
1+
\frac{
\rho C_LA
}{
2mg
}w
\right).
$$

Define

$$
\gamma
=
\frac{
\rho C_LA
}{
2mg
}.
$$

Then

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

the lateral speed cap is

$$
\boxed{
w_{\rm lat}
=
\frac{
a_{y,0}
}{
|\kappa|-a_{y,0}\gamma
}.
}
$$

Otherwise the simplified downforce model yields no finite pure-lateral cap, and the hard maximum speed applies.

The pointwise cap is

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

For coarse evaluation, $|\kappa|$ shall be replaced by the conservative interval curvature bound.

---

# 14. Periodic speed-profile solver

For a fixed geometry, solve the maximum feasible periodic speed profile.

## 14.1 Spatial dynamics

Because

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

## 14.2 Discrete state

At station $i$, store

$$
w_i,
\quad
\bar w_i,
\quad
\kappa_i,
\quad
\Delta\ell_i.
$$

Indices are periodic.

## 14.3 Forward operator

Given $w_i$, compute the largest feasible $w_{i+1}$ satisfying

$$
w_{i+1}
=
w_i+
2\Delta\ell_i
a_{\max}
\left(
\sqrt{
\frac{w_i+w_{i+1}}2
},
\kappa_{i+1/2}
\right).
$$

Use a safeguarded Newton iteration with bisection fallback.

## 14.4 Backward operator

Given $w_{i+1}$, compute the largest feasible $w_i$ satisfying

$$
w_i
=
w_{i+1}
+
2\Delta\ell_i
b_{\max}
\left(
\sqrt{
\frac{w_i+w_{i+1}}2
},
\kappa_{i+1/2}
\right).
$$

## 14.5 Cyclic fixed point

Initialize

$$
w_i=\bar w_i.
$$

Perform alternating complete forward and backward sweeps:

$$
w_{i+1}
\leftarrow
\min
\left(
w_{i+1},
\bar w_{i+1},
F_i(w_i)
\right),
$$

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

Stop when

$$
\max_i
\frac{
|w_i^{(n+1)}-w_i^{(n)}|
}{
1+w_i^{(n)}
}
<
\varepsilon_w.
$$

Forward/backward speed-profile propagation is well established in racing trajectory generation, and reachability-based time-optimal path parameterization provides a more general robust interpretation of the same backward-controllability and forward-maximality structure.

## 14.6 Lap time

Use

$$
\boxed{
T
=
\sum_i
\frac{
2\Delta\ell_i
}{
\sqrt{w_i}+\sqrt{w_{i+1}}
}.
}
$$

The final lap time shall use compensated or FP64 summation.

## 14.7 Fixed-path optimality check

Define

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

At a maximum feasible speed profile,

$$
\boxed{
\min
\left(
s_i^{\rm cap},
s_i^{\rm acc},
s_i^{\rm brake}
\right)
\approx0
}
$$

at every regular station.

Stations where all three slacks are significantly positive indicate an incomplete speed solve.

---

# 15. Optimization workflow

## 15.1 Stage 0 — track preprocessing

1. Validate PH centerline and offsets.
2. Construct exact arc-length lookup.
3. Construct fast boundary representation.
4. Fit the Fourier kernel spine.
5. Fit or derive the transverse field.
6. Validate the kernel chart.
7. Precompute heading-conditioned rectangle-safe intervals.
8. Construct the robust global corridor.
9. Build Fourier and B-spline basis tables.
10. Generate baseline feasible paths.

## 15.2 Stage 1 — Fourier-only global discovery

Use

$$
z_B=0.
$$

Optimize only low Fourier modes.

This stage shall discover:

- major corner-cutting structure;
- broad outside-inside-outside transitions;
- interactions between consecutive corners;
- long-path versus high-radius trade-offs.

Use coarse geometry, conservative corner checking, and a lap-time proxy.

## 15.3 Stage 2 — spectral continuation

Increase Fourier bandwidth gradually:

$$
K_F^{(0)}
\rightarrow
K_F^{(1)}
\rightarrow
\cdots
\rightarrow
K_F^{\max}.
$$

New modes start at zero or small random variance.

Previously optimized low modes are retained.

This continuation prevents high-frequency parameters from obscuring large-scale structure before it has been discovered.

## 15.4 Stage 3 — activate local B-spline residual

Enable the coarsest local B-spline level.

The new residual initially equals zero, so the trajectory is unchanged.

Use exact periodic knot insertion when refining.

The B-spline residual shall remain orthogonal to the Fourier subspace.

## 15.5 Stage 4 — hierarchical local refinement

Insert local spline resolution where feature indicators are large.

Define span indicator

$$
I_j
=
c_1\max_{I_j}|\kappa_\ell|
+
c_2\max_{I_j}|\kappa_{\ell\ell}|
+
c_3\max_{I_j}\left|\frac{dv}{d\ell}\right|
+
c_4A_j^{\rm boundary}
+
c_5S_j^{\rm time}
+
c_6U_j^{\rm alias}.
$$

Here:

- $A_j^{\rm boundary}$ indicates active corner/boundary constraints;
- $S_j^{\rm time}$ estimates lap-time sensitivity;
- $U_j^{\rm alias}$ measures unresolved curvature uncertainty.

Only high-indicator spans receive finer knots.

## 15.6 Stage 5 — full dynamic optimization

At this stage every retained candidate receives:

- full rectangle-corner evaluation;
- full cyclic speed solve;
- true lap-time evaluation;
- curvature-quality diagnostics.

The corridor is gradually widened from the robust global corridor toward the exact heading-conditioned feasible region.

## 15.7 Stage 6 — batched local geometric search

For each elite, evaluate batched perturbations in:

- Fourier coefficients;
- local B-spline coefficients;
- low-frequency combined directions;
- localized coefficient blocks.

Use:

$$
\mathbf q\pm h_j\mathbf e_j.
$$

Where the active set is stable, estimate directional derivatives using central differences.

Where the active set changes, use direct feasible-improvement comparisons.

## 15.8 Stage 7 — curvature-space conversion

For every surviving elite:

1. resample uniformly in actual arc length;
2. unwrap tangent angle;
3. compute

$$
   K_*(\tau)=L\kappa(\tau);
$$

4. fit the hybrid Fourier-plus-periodic-B-spline curvature representation;
5. verify fit error;
6. initialize the closure projector.

## 15.9 Stage 8 — closure-projected curvature optimization

Optimize free curvature coefficients and length.

For every perturbation:

1. form proposed free curvature field;
2. apply the three-mode closure projector;
3. reconstruct the closed trajectory;
4. align it to the parent;
5. test regularity and progression;
6. test all rectangle vertices;
7. solve the speed profile;
8. rank by feasibility and lap time.

Use small trust regions and homotopy backtracking.

Target closure-projection success:

$$
\boxed{
R_{\rm close-success}\ge99.9\%
}
$$

for accepted trust-region perturbations.

## 15.10 Stage 9 — minimum-time-preserving smoothing

Let the best observed lap time be

$$
T_*.
$$

Solve

$$
\boxed{
\min R_\kappa
}
$$

subject to

$$
T
\le
T_*+\Delta T_{\rm smooth}
$$

and all hard constraints.

Use

$$
\Delta T_{\rm smooth}
=
\max
\left(
\varepsilon_{\rm rel}T_*,
2\varepsilon_{\rm mesh}
\right).
$$

Recommended initial range:

$$
\varepsilon_{\rm rel}
=
10^{-5}\text{ to }10^{-4}.
$$

This stage removes numerical curvature defects only when their removal does not materially reduce performance.

## 15.11 Stage 10 — final certification

Run:

- high-resolution geometry evaluation;
- exact PH boundary queries;
- adaptive corner containment;
- conservative curvature bounds;
- converged FP64 speed solve;
- mesh refinement;
- basis refinement;
- local directional tests.

Only this stage may mark a result `CERTIFIED`.

---

# 16. Population optimizer

The recommended global optimizer is a frequency-separated multi-island evolution strategy.

## 16.1 Island state

Each island maintains:

- mean Fourier coefficients;
- mean B-spline coefficients;
- separate low-, medium-, and local-frequency step sizes;
- elite archive;
- feasibility statistics;
- stagnation counter.

For low-dimensional Fourier-only stages, a small full covariance matrix may be used.

For large B-spline stages, use:

- diagonal covariance;
- local block covariance;
- or limited-memory covariance.

A dense $O(N^2)$ covariance matrix shall not be required for the finest representation.

## 16.2 Antithetic sampling

Generate pairs

$$
\mathbf x_+
=
\mathbf m+\boldsymbol\sigma\odot\boldsymbol\epsilon,
$$

$$
\mathbf x_-
=
\mathbf m-\boldsymbol\sigma\odot\boldsymbol\epsilon.
$$

Antithetic pairs reduce sampling noise and map naturally to GPU batches.

## 16.3 Frequency-separated mutation

Generate perturbations as

$$
\delta z
=
\delta z_{\rm global}
+
\delta z_{\rm medium}
+
\delta z_{\rm local}.
$$

Maintain distinct step sizes:

$$
\sigma_F,
\qquad
\sigma_{B,\rm coarse},
\qquad
\sigma_{B,\rm fine},
\qquad
\sigma_\kappa.
$$

Fine-scale variance shall not be allowed to grow merely because coarse-scale progress stalls.

## 16.4 Mutation scaling

A lateral perturbation of amplitude $A$ and spatial scale $h$ produces curvature variation of approximate order

$$
\Delta\kappa\sim\frac{A}{h^2}.
$$

Therefore fine-scale position mutation shall scale approximately as

$$
\boxed{
\sigma_d(h)\propto h^2.
}
$$

During curvature-quality polishing, use

$$
\sigma_d(h)\propto h^3
$$

or direct curvature-coordinate perturbations.

## 16.5 Feasible-parent repair

For a feasible parent $\mathbf x_p$ and invalid proposal $\mathbf x_t$, search

$$
\mathbf x(\alpha)
=
\mathbf x_p+
\alpha
\left(
\mathbf x_t-\mathbf x_p
\right)
$$

with

$$
\alpha=1,\frac12,\frac14,\ldots.
$$

Accept the largest feasible $\alpha$.

This repair preserves:

- periodicity;
- basis smoothness;
- parent proximity;
- local feature direction.

## 16.6 Island diversity

Retain several geometrically distinct near-optimal paths.

Define

$$
D_{ab}
=
\left[
\int_0^1
\left(
d_a(u)-d_b(u)
\right)^2du
\right]^{1/2}.
$$

Do not permit all islands to collapse onto the same basin before local refinement.

Migrate only a subset of elites between islands.

Restart stagnant islands around:

- archived alternative solutions;
- boundary-biased seeds;
- new low-frequency samples.

---

# 17. Multi-fidelity scoring funnel

## 17.1 Fidelity A — structural decode

Evaluate:

- finite values;
- corridor inclusion;
- progression;
- coarse relative yaw;
- coarse curvature;
- coarse rectangle feasibility.

No speed solve.

## 17.2 Fidelity B — coarse proxy

Use

$$
T_{\rm lateral}
=
\sum_i
\frac{
\Delta\ell_i
}{
\min
\left(
v_{\max},
v_{{\rm lat},i}
\right)
}.
$$

Add proxy indicators for:

- path length;
- required braking caused by speed-cap decreases;
- curvature roughness;
- boundary clearance;
- unresolved curvature uncertainty.

The proxy shall only rank the large first-stage population.

## 17.3 Fidelity C — reduced speed solve

Use:

- fewer stations;
- fixed forward/backward sweep count;
- FP32;
- conservative curvature values.

## 17.4 Fidelity D — full speed solve

Use:

- production station count;
- converged cyclic speed profile;
- exact nodal rectangle tests;
- complete dynamics.

## 17.5 Fidelity E — curvature-space evaluation

Used only for elites.

Includes:

- closure projection;
- intrinsic reconstruction;
- full dynamics;
- exact corner checks.

## 17.6 Fidelity F — certification

Includes:

- adaptive continuous checking;
- exact PH geometry;
- FP64;
- mesh and basis convergence.

A configurable random fraction of candidates outside the proxy elite shall be promoted to higher fidelity. This prevents an imperfect proxy from systematically excluding unconventional but fast trajectories.

---

# 18. Candidate ranking

Use feasibility-first lexicographic ranking.

Define normalized violation vector

$$
\mathbf v=
\begin{bmatrix}
v_{\rm corner}\\
v_{\rm progression}\\
v_{\rm regularity}\\
v_{\rm curvature}\\
v_{\rm dynamics}\\
v_{\rm closure}\\
v_{\rm numerical}
\end{bmatrix}.
$$

Let

$$
V_{\max}=\|\mathbf v\|_\infty.
$$

Rank by

$$
\boxed{
\left(
I_{\rm infeasible},
V_{\max},
T,
R_\kappa,
-\operatorname{clearance}_{\min}
\right).
}
$$

Here

$$
I_{\rm infeasible}
=
\begin{cases}
0,&V_{\max}=0,\\
1,&V_{\max}>0.
\end{cases}
$$

A fixed weighted penalty shall not be the sole ranking mechanism.

Lap times within the numerical-equivalence band

$$
|T_1-T_2|
\le
\max
\left(
\varepsilon_T,
c_T\varepsilon_{\rm mesh}
\right)
$$

shall be ranked by curvature quality and clearance.

---

# 19. GPU architecture

## 19.1 Hardware target

The primary binary shall target the RTX 4080 Ada architecture and shall query runtime properties rather than hard-code occupancy or memory assumptions.

The implementation should compile a native Ada kernel image and an appropriate PTX fallback.

## 19.2 Device-resident optimization loop

After track preprocessing and upload, the recurring population loop shall remain on the GPU.

Host-device transfers shall be restricted to:

- progress telemetry;
- user cancellation;
- checkpointing;
- selected elite export;
- final result.

## 19.3 Fourier evaluation

For very large batches, evaluate the Fourier backbone as matrix multiplication:

$$
Z_F=FQ,
$$

where:

- $F$ contains Fourier basis values at track stations;
- $Q$ contains candidate coefficients.

Derivative fields use precomputed matrices

$$
F^{(1)},
\quad
F^{(2)},
\quad
F^{(3)},
\quad
F^{(4)}.
$$

For small mode counts, a fused custom kernel may outperform separate matrix multiplications.

The implementation shall benchmark both approaches.

## 19.4 B-spline evaluation

A periodic quintic spline has six locally active basis functions per station.

Precompute:

- active control-point indices;
- $B_j$;
- $B_j'$;
- $B_j''$;
- $B_j'''$;
- $B_j''''$.

The residual shall be added in the same kernel that performs bounded decoding and geometry evaluation.

## 19.5 Memory layout

Candidate-dependent station arrays shall be stored station-major:

$$
\texttt{field[station][candidate]}.
$$

Adjacent warp threads then access adjacent candidates at the same station.

Global memory coalescing is a primary CUDA performance requirement.

Use structure-of-arrays storage for:

- $d$;
- derivatives of $d$;
- curvature;
- interval length;
- speed;
- speed cap;
- validity flags;
- clearance where retained.

Recompute inexpensive intermediate values when this saves significant global-memory traffic.

## 19.6 Kernel mapping

### Geometry kernel

One thread per

$$
(\text{candidate},\text{station}).
$$

Responsibilities:

- Fourier field evaluation;
- B-spline residual;
- bounded decode;
- trajectory derivatives;
- curvature;
- curvature derivative;
- four corner transforms;
- fast lane queries;
- pointwise speed cap;
- geometric validity.

### Speed kernel

One thread per candidate.

Each thread loops sequentially around the track for one forward or backward sweep.

Parallelism comes from the number of candidate trajectories.

### Curvature-projector kernel

One thread block per elite candidate.

Threads cooperate on:

- curvature evaluation;
- cumulative angle integration;
- closure quadrature;
- $3\times3$ Jacobian accumulation;
- closure Newton iteration;
- reconstructed coordinate integration.

## 19.7 Compaction

Invalid candidates shall be compacted before expensive stages.

Use optimized device-wide scan, selection, and sorting primitives.

## 19.8 CUDA Graphs

The recurring sequence of:

- generation;
- geometry;
- compaction;
- proxy scoring;
- speed sweeps;
- ranking;
- population update

shall be captured in one or more CUDA Graphs.

CUDA Graphs reduce repeated host-side launch preparation overhead for workflows containing many recurring short kernels.

## 19.9 Random-number generation

Use a counter-based Philox generator.

Map each random sample to

$$
(
\text{root seed},
\text{generation},
\text{island},
\text{candidate},
\text{variable},
\text{stream}
).
$$

Philox supports independent subsequences and efficient vectorized generation through the CUDA random-number API.

## 19.10 Precision policy

### Coarse global search

- FP32 geometry;
- FP32 dynamics;
- fast transcendental operations where validated.

### Full candidate evaluation

- FP32 geometry and speed arrays;
- compensated or FP64 lap-time accumulation;
- conservative geometry margins.

### Curvature projection

- FP32 initial iterations if throughput requires;
- FP64 final closure correction for retained candidates.

### Certification

- FP64 CPU or GPU reference;
- exact PH evaluation;
- no fast-math dependence.

The RTX 4080 shall be used primarily for wide FP32 search. Final FP64 certification concerns only a very small elite set.

## 19.11 Deterministic mode

Deterministic mode requires:

- fixed seed;
- fixed candidate order;
- fixed island migration;
- fixed reduction trees;
- fixed graph topology;
- no unordered floating-point atomic accumulation;
- recorded compiler and runtime versions.

Bitwise reproducibility is required only for the same executable, hardware model, driver family, and compiler configuration.

## 19.12 Nondeterministic mode

Nondeterministic mode uses:

- fresh operating-system entropy;
- optional randomized island migration;
- randomized restart timing;
- performance-oriented unordered operations where safe.

---

# 20. Throughput targets

The implementation shall benchmark representative tracks and report throughput as a function of:

- candidate count;
- station count;
- Fourier mode count;
- B-spline level;
- speed sweep count;
- exact-boundary fraction;
- curvature-projector iterations.

Initial engineering targets on RTX 4080:

## 20.1 Coarse geometry

$$
\boxed{
R_{\rm station}\ge10^8
\text{ candidate-stations/s}
}
$$

for the low-resolution geometry kernel.

## 20.2 Coarse candidate proxy

At approximately 64–128 stations:

$$
\boxed{
R_{\rm proxy}\ge10^6
\text{ candidates/s}
}
$$

shall be treated as a target, not an assumed result.

## 20.3 Full dynamic laps

Full-lap throughput shall be measured and reported rather than assigned a misleading million-per-second requirement.

## 20.4 Acceptance

Global robust-corridor generation:

$$
\boxed{
R_{\rm geom-accept}\ge95\%.
}
$$

Feasible-parent local search:

$$
\boxed{
R_{\rm geom-accept}\ge99\%.
}
$$

Curvature closure projection inside its trust region:

$$
\boxed{
R_{\rm close-success}\ge99.9\%.
}
$$

## 20.5 Memory

Peak GPU allocation shall remain below

$$
14\ {\rm GB}
$$

on a 16 GB device.

Population arrays shall be tiled when necessary.

---

# 21. Optimality and quality checks

Every final result shall include an `OptimalityReport`.

## 21.1 Closure checks

Discovery representation:

$$
\|\mathbf r(1)-\mathbf r(0)\|
$$

and periodic derivative residuals through fourth order.

Curvature representation:

$$
|C_0|,
\quad
|C_x|,
\quad
|C_y|.
$$

## 21.2 Geometry checks

Report:

$$
L,
\quad
\max|\kappa|,
\quad
\max|\kappa_\ell|,
\quad
\max|\kappa_{\ell\ell}|,
$$

$$
\min\|\mathbf r_u\|,
$$

$$
\min
\frac{
\mathbf r_u\cdot\mathbf c_K'
}{
\|\mathbf r_u\|
\|\mathbf c_K'\|
}.
$$

## 21.3 Rectangle checks

Report:

- minimum nodal corner clearance;
- minimum continuously certified clearance;
- responsible corner;
- responsible track station;
- number of adaptive subdivisions;
- boundary approximation error.

## 21.4 Dynamics checks

Report:

- maximum and minimum speed;
- maximum acceleration;
- maximum braking;
- maximum lateral acceleration;
- maximum superellipse utilization;
- maximum drag acceleration;
- maximum downforce load multiplier;
- maximum and RMS lateral jerk.

## 21.5 Fixed-path speed optimality

Report the normalized maximum of

$$
\min
\left(
s_i^{\rm cap},
s_i^{\rm acc},
s_i^{\rm brake}
\right).
$$

Classify every speed station as:

- hard-speed limited;
- lateral-grip limited;
- acceleration limited;
- braking limited;
- switching;
- unresolved.

## 21.6 Geometric local optimality

For final Fourier coefficients, B-spline coefficients, and curvature coefficients, evaluate positive and negative feasible perturbations.

For variable $x_j$,

$$
D_j^+
=
\frac{
T(x+h_je_j)-T(x)
}{h_j},
$$

$$
D_j^-
=
\frac{
T(x-h_je_j)-T(x)
}{h_j}.
$$

Report the best discovered feasible descent.

Also evaluate random smooth directions from each frequency band.

A path shall not be classified as locally polished when a tested direction produces improvement larger than tolerance.

## 21.7 Mesh convergence

Evaluate at

$$
N,
\quad
2N,
\quad
4N
$$

stations.

Require

$$
|T_{4N}-T_{2N}|
\le
\varepsilon_{\rm mesh}.
$$

## 21.8 Basis convergence

Perform:

- one additional Fourier-band extension;
- one additional local spline refinement;
- one additional curvature-spline refinement.

Allow local reoptimization.

Report the improvement from each extension.

A significant improvement indicates that the previous representation was not sufficiently expressive.

---

# 22. Output representation

The optimizer shall return both geometric forms.

## 22.1 Discovery representation

Store:

- Fourier kernel chart identifier;
- Fourier lateral coefficients;
- periodic B-spline residual coefficients;
- corridor and chart metadata.

This representation is compact and convenient for restart and local track-coordinate editing.

## 22.2 Final curvature representation

Store:

- path length $L$;
- winding number;
- Fourier curvature coefficients;
- periodic B-spline curvature coefficients;
- closure-correction coefficients;
- rigid transform;
- seam phase;
- closure residuals.

This is the authoritative final representation after curvature polish.

## 22.3 Sampled trajectory

Store:

- track coordinate;
- normalized arc coordinate;
- actual arc length;
- $x,y$;
- tangent;
- yaw;
- curvature;
- curvature derivatives;
- speed;
- longitudinal acceleration;
- lateral acceleration;
- active constraint;
- all four rectangle vertices;
- clearances.

## 22.4 Provenance

Store:

- input settings;
- PH track hash;
- optimizer configuration;
- random seed;
- run mode;
- GPU model;
- CUDA version;
- build identifier;
- stage timings;
- candidate counts;
- acceptance rates;
- throughput metrics;
- mesh-convergence results;
- basis-convergence results.

---

# 23. Software architecture

```text
track/
    ph_curve
    ph_arc_length
    ph_offsets
    ph_validator
    exact_lane_query
    fast_lane_query
    boundary_bvh

chart/
    fourier_kernel_fit
    transverse_field_fit
    chart_validator
    rectangle_safe_corridor

basis/
    fourier_basis
    periodic_bspline
    orthogonal_residual
    hierarchical_refinement

geometry/
    lateral_decoder
    chart_trajectory
    analytic_derivatives
    curvature
    rectangle_vertices
    continuous_containment

curvature/
    curvature_fit
    curvature_hybrid_basis
    closure_projector
    intrinsic_reconstruction
    procrustes_alignment

dynamics/
    aero
    acceleration_superellipse
    speed_caps
    cyclic_speed_solver
    lap_time

optimizer/
    seed_generation
    island_evolution
    frequency_continuation
    spline_refinement
    feasible_repair
    local_pattern_search
    curvature_polish
    smoothing_stage

cuda/
    fourier_gemm
    spline_kernels
    geometry_kernels
    containment_kernels
    speed_kernels
    closure_kernels
    ranking
    compaction
    philox
    graph_executor

validation/
    cpu_reference
    closure_tests
    geometry_tests
    dynamics_tests
    mesh_convergence
    basis_convergence
    deterministic_replay

api/
    settings
    telemetry
    result
    serialization
```

---

# 24. Implementation sequence

## Milestone 1 — exact CPU reference

Implement in FP64:

- PH centerline;
- PH arc length;
- PH offsets;
- lane membership;
- Fourier kernel fit;
- hybrid lateral representation;
- analytic curvature;
- rectangle corners;
- speed solver;
- curvature reconstruction;
- closure projection.

## Milestone 2 — Fourier/B-spline GPU geometry

Implement:

- Fourier basis evaluation;
- B-spline residual evaluation;
- bounded decode;
- analytic derivatives;
- curvature;
- four-corner screening;
- compaction.

## Milestone 3 — GPU speed solver

Implement:

- speed caps;
- forward/backward propagation;
- cyclic convergence;
- lap-time reduction;
- active-limit classification.

## Milestone 4 — global spectral optimizer

Implement:

- island state;
- antithetic sampling;
- spectral continuation;
- proxy funnel;
- feasible-first ranking;
- migration and restart.

## Milestone 5 — hierarchical B-spline refinement

Implement:

- exact knot insertion;
- local basis activation;
- span sensitivity;
- feasible-parent repair;
- local batched search.

## Milestone 6 — curvature closure projector

Implement:

- curvature fit;
- correction-mode selection;
- analytic closure Jacobian;
- damped Newton;
- homotopy fallback;
- intrinsic reconstruction;
- Procrustes alignment.

## Milestone 7 — continuous certification

Implement:

- conservative boundary distances;
- adaptive corner interval bounds;
- curvature interval bounds;
- exact PH final query;
- FP64 final report.

---

# 25. Test requirements

## 25.1 Fourier kernel tests

Test on:

- circle;
- ellipse;
- oval;
- asymmetric closed PH track;
- PH seam with nontrivial segment joins.

Verify:

- periodicity;
- regularity;
- chart Jacobian;
- fit error;
- normal/transverse-field consistency.

## 25.2 Hybrid basis tests

Verify:

$$
P_Fz_B=0
$$

to numerical tolerance.

Test:

- Fourier-only field;
- spline-only field;
- mixed field;
- knot insertion;
- periodic seam;
- derivative continuity through fourth order.

## 25.3 Curvature reconstruction tests

Use:

- constant curvature circle;
- analytically generated Fourier-angle curves;
- known closed curvature profiles;
- random perturbations around a circle;
- random perturbations around a racing line.

Verify:

$$
C_0=C_x=C_y=0
$$

after projection.

Measure closure-projector convergence rate and Jacobian conditioning.

## 25.4 Rectangle tests

Test:

- straight track;
- circular lane;
- tight corner;
- varying track width;
- seam crossing;
- all four individual corner-contact cases;
- diagonal vehicle orientation;
- close parallel track sections.

## 25.5 Continuous containment tests

Construct trajectories that:

- are safe at nodes but violate between nodes;
- approach a boundary tangentially;
- cross a boundary in a narrow interval;
- contain high curvature near a corner.

The adaptive certifier must detect every violation.

## 25.6 Dynamics tests

### Zero aerodynamic terms

$$
C_DA=C_LA=0.
$$

Compare against constant capability formulas.

### Drag-only straight

Verify terminal behavior where

$$
a_{+,0}=a_D(v).
$$

### Constant-curvature circle

Compare lateral speed cap analytically.

### Superellipse

Verify

$$
\left(
\frac{|a_x|}{A_x}
\right)^p
+
\left(
\frac{|a_y|}{A_y}
\right)^p
\le1.
$$

### Closed speed profile

Verify seam consistency and active-limit coverage.

## 25.7 CPU/GPU equivalence

For random feasible candidates, compare:

- decoded $d$;
- derivatives;
- $x,y$;
- curvature;
- curvature derivatives;
- corner positions;
- lane margins;
- speed caps;
- speed profile;
- lap time;
- closure residuals.

## 25.8 Deterministic replay

Repeated deterministic runs shall reproduce:

- generated coefficients;
- candidate ranking;
- stage transitions;
- final trajectory;
- serialized result.

---

# 26. Release acceptance criteria

## 26.1 Structural geometry

- All discovery candidates are closed by representation.
- All final curvature candidates accepted by the projector satisfy closure tolerance.
- Discovery trajectories are at least $C^4$.
- Final curvature trajectories are at least $C^6$.
- There are no curvature or curvature-rate jumps.

## 26.2 Track containment

- All safety-expanded rectangle vertices satisfy exact nodal containment.
- Continuous adaptive containment passes.
- Conservative minimum clearance is nonnegative.

## 26.3 Dynamics

- Maximum speed is respected.
- Lateral capability is respected.
- The acceleration superellipse is respected.
- The optional geometric curvature limit is respected.
- The periodic speed profile converges.
- Every speed station has an active limiting mechanism within tolerance.

## 26.4 Numerical convergence

- Mesh refinement converges.
- Fourier-band extension yields no material improvement.
- B-spline refinement yields no material improvement.
- Curvature-basis refinement yields no material improvement.
- Batched local perturbations find no improvement above tolerance.

## 26.5 Acceptance performance

- Global geometric acceptance is at least 95%.
- Local geometric acceptance is at least 99%.
- Curvature closure projection succeeds for at least 99.9% of trust-region proposals.
- Invalid-candidate cost is reduced through early compaction.

## 26.6 GPU performance

- Coarse candidate-station throughput meets the measured target range.
- Millions of low-resolution proxy candidates per second are demonstrated where station count and model fidelity permit.
- Full-lap throughput is reported honestly as a separate metric.
- Peak VRAM remains below 14 GB.
- The steady-state population loop remains predominantly GPU-resident.

---

# 27. Canonical references

1. **R. T. Farouki, Pythagorean-hodograph curves.** PH curves provide exact polynomial arc length and rational offsets, supporting their use as the authoritative track representation.

2. **C. T. Zahn and R. Z. Roskies, “Fourier Descriptors for Plane Closed Curves.”** Classical intrinsic Fourier representation of closed planar curves and separation of macroscopic and high-frequency shape content.

3. **M. Saba, T. Schneider, K. Hormann, and R. Scateni, “Curvature-based blending of closed planar curves.”** Demonstrates that interpolation or modification in curvature space does not automatically preserve closure and motivates an explicit closure correction.

4. **H. Xue, T. Yue, and J. M. Dolan, “Spline-Based Minimum-Curvature Trajectory Optimization for Autonomous Racing.”** Racing-specific use of B-spline control variables, local geometric control, and dimensionality reduction.

5. **N. R. Kapania, J. K. Subosits, and J. C. Gerdes, “A Sequential Two-Step Algorithm for Fast Generation of Vehicle Racing Trajectories.”** Forward/backward speed propagation and iterative curvature/path refinement under racing constraints.

6. **H. Pham and Q.-C. Pham, “A New Approach to Time-Optimal Path Parameterization Based on Reachability Analysis.”** Robust backward controllability and forward time-optimal propagation framework.

7. **NVIDIA CUDA Programming and Best Practices documentation.** Required implementation guidance for coalesced memory access, launch overhead, CUDA Graphs, and GPU execution structure.

---

# 28. Final architecture statement

The normative trajectory-optimization architecture is:

$$
\boxed{
\begin{array}{c}
\text{PH centerline and exact PH offset lane}\\[2mm]
\downarrow\\[2mm]
\text{smooth periodic Fourier kernel chart}\\[2mm]
\downarrow\\[2mm]
\text{low-frequency Fourier racing-line backbone}\\[2mm]
+\ 
\text{high-pass periodic B-spline local residual}\\[2mm]
\downarrow\\[2mm]
\text{rectangle-safe GPU population optimization}\\[2mm]
\downarrow\\[2mm]
\text{full minimum-time speed-profile evaluation}\\[2mm]
\downarrow\\[2mm]
\text{intrinsic Fourier/B-spline curvature representation}\\[2mm]
\downarrow\\[2mm]
\text{three-condition closure projection}\\[2mm]
\downarrow\\[2mm]
\text{minimum-time curvature refinement and smoothing}\\[2mm]
\downarrow\\[2mm]
\text{continuous rectangle and dynamics certification}.
\end{array}
}
$$

This architecture preserves the global feature-discovery advantage of Fourier modes, the local expressiveness of periodic B-splines, and the physical/geometric clarity of direct curvature modeling without subjecting the global GPU population to a low-acceptance nonlinear curve-closure problem.