/* Optiline — PH construction: Gram displacement, analytic Jacobian,
 * pivoted Householder QR, minimum-norm projection, deterministic seed,
 * strict-local edits (§9.2–§9.9). */
#ifndef OPTILINE_OP_CONSTRUCTION_H
#define OPTILINE_OP_CONSTRUCTION_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Maximum patch: three-gate edit uses K=7 logical intervals -> 14 spans,
 * 12 free complex controls -> n = 24 real unknowns, m = 14 real equations.
 * Global solve: 128 free complex controls -> n = 256, m = 128. */
#define OP_QR_MAX_N 256
#define OP_QR_MAX_M 128

typedef struct op_qr_workspace {
    double a[OP_QR_MAX_N * OP_QR_MAX_M]; /* A = J^T, column-major        */
    double tau[OP_QR_MAX_M];
    double colnorm[OP_QR_MAX_M];
    int32_t perm[OP_QR_MAX_M];
    double y[OP_QR_MAX_M];
    double delta[OP_QR_MAX_N];
    double f[OP_QR_MAX_M];               /* residual vector              */
    double f_trial[OP_QR_MAX_M];
} op_qr_workspace;

/* Exact quadratic Bernstein Gram matrix (§9.2), row-major 3x3. */
extern const double OP_GRAM[9];

/* Displacement Phi(b) = h b^T G b and its analytic derivative helper
 * v_k = 2h sum_a G[k][a] b_a (§9.3). */
op_c64 op_construction_phi(const op_c64 b[3]);
void   op_construction_phi_grad(const op_c64 b[3], op_c64 v[3]);

/* Interpolation residual F_i = Phi(b_{2i}) + Phi(b_{2i+1}) - D_i for all
 * 64 logical intervals; D from gate points (§9.1–§9.2). */
void op_construction_residuals(const op_c64 c[OP_SPAN_COUNT],
                               const op_c64 gate_points[OP_GATE_COUNT],
                               op_c64 F[OP_GATE_COUNT]);

/* Minimum-norm Newton projection (§9.5) over an index set of free complex
 * controls. free_idx lists global control indices (unwrapped, §9.8 lifted
 * gauge for seam-crossing patches). rtol: 1e-12 binary64 / 1e-7 GPU.
 * max_iter: 40 binary64 / 12 GPU. tol_h: residual acceptance |F|max bound.
 * On success writes updated controls back into c. */
op_result op_construction_project(op_c64 c[OP_SPAN_COUNT],
                                  const op_c64 gate_points[OP_GATE_COUNT],
                                  const int32_t *free_idx, int32_t free_count,
                                  const int32_t *constraint_idx, int32_t constraint_count,
                                  double rtol, int max_iter, double tol_abs,
                                  op_qr_workspace *ws);

/* Deterministic initial seed (§9.4): guide velocities, principal square
 * roots, two-state sign dynamic program, half-gate interpolation. */
op_result op_construction_seed(const op_c64 gate_points[OP_GATE_COUNT],
                               op_c64 c[OP_SPAN_COUNT]);

/* Full construction from a genotype: seed (or warm start), global
 * projection, span compilation, independent verification (§9.5).
 * warm may be NULL; tolerances are the binary64 set. */
op_result op_construction_build(const op_track *track, const op_genotype *g,
                                const op_spline *warm, op_spline *out,
                                op_qr_workspace *ws, double *max_residual);

/* Strict-local one-gate edit (§9.6, K=5) and three-gate edit (§9.7, K=7)
 * with weights (1/4,1/2,1/4)*delta_d. gate is the center gate. Exterior
 * controls remain bitwise unchanged; failure leaves everything unchanged
 * (§9.9). Binary64 tolerance set. */
op_result op_construction_edit_one(const op_track *track, op_spline *sp,
                                   op_genotype *g, int32_t gate, double new_d,
                                   op_qr_workspace *ws);
op_result op_construction_edit_three(const op_track *track, op_spline *sp,
                                     op_genotype *g, int32_t gate, double delta_d,
                                     op_qr_workspace *ws);

/* Independent post-solve verification (§9.5): interpolation, seam position,
 * tangent, curvature continuity, regularity, positive length. */
op_result op_construction_verify(const op_spline *sp,
                                 const op_c64 gate_points[OP_GATE_COUNT],
                                 double tol_interp, double sigma_ref,
                                 double *max_residual);

/* Householder QR with column pivoting on A (n x m, column-major, n >= m),
 * ties to the smallest original column index; reflector sign avoids
 * subtraction (§9.5). Exposed for tests. */
op_result op_qr_min_norm_step(double *a, int32_t n, int32_t m,
                              const double *f, double rtol,
                              double *delta, op_qr_workspace *ws);

/* Signed area of the racing line (§9.10) with compensated summation. */
double op_spline_signed_area(const op_spline *sp);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_CONSTRUCTION_H */
