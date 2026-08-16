/* Optiline — quintic PH span compilation and evaluation (§8.3–§8.6). */
#ifndef OPTILINE_OP_SPAN_H
#define OPTILINE_OP_SPAN_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Extract quadratic Bezier preimage controls of span j from the 128
 * antiperiodic global controls (§8.3): b0=(c_{j-1}+c_j)/2, b1=c_j,
 * b2=(c_j+c_{j+1})/2 with the §5.4 antiperiodic rule. */
void op_span_extract_preimage(const op_c64 *c, int32_t j, op_c64 b[3]);

/* Compile hodograph q[5], speed r[5], position p[6] from start point p0,
 * and arc coefficients sA[6] (§8.4–§8.5). r uses the explicit real
 * formulas; a complex r with a discarded imaginary part is nonconforming. */
void op_span_compile(op_span *sp, const op_c64 b[3], op_c64 p0);

/* Compile all 128 spans of a spline whose controls c and gate points P
 * are already set. Span start points follow §9.2 exactly:
 * p_{2i,0} = P_i and p_{2i+1,0} = P_i + Phi(b_{2i}).
 * Also fills cum_len / total_len with Neumaier summation. */
op_result op_spline_compile(op_spline *sp, const op_c64 gate_points[OP_GATE_COUNT]);

/* Point, derivative dz/dnu, unit tangent, left normal, signed physical
 * curvature at local nu in [0,1] (§8.6). Tangent uses w-normalization:
 * w_hat=(a,b); Tx=(a-b)(a+b); Ty=2ab. Requires a regular span. */
op_c64 op_span_point(const op_span *sp, double nu);
op_c64 op_span_dz(const op_span *sp, double nu);
op_c64 op_span_preimage(const op_span *sp, double nu);
op_c64 op_span_preimage_dnu(const op_span *sp, double nu);
op_result op_span_frame(const op_span *sp, double nu,
                        op_c64 *tangent, op_c64 *normal_left, double *kappa);

/* Exact forward arc length S_f(nu) and reverse S_r(v)=L-S_f(1-v) (§8.5). */
double op_span_arc_forward(const op_span *sp, double nu);
double op_span_arc_reverse(const op_span *sp, double v);

/* Exact displacement of one span: Phi(b) = h b^T G b (§9.2). */
op_c64 op_span_displacement(const op_c64 b[3]);

/* Degree-3 Bernstein coefficients of A = Im(conj(w) w_nu) (§12.1). */
void op_span_a_coeffs(const op_span *sp, double a3[4]);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_SPAN_H */
