/* Optiline — regularity and curvature-bound certificates (§8.7, §8.11, §12.1). */
#ifndef OPTILINE_OP_REGULARITY_H
#define OPTILINE_OP_REGULARITY_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Binary64 regularity certificate for one span (§8.7): recursive hull
 * subdivision until |w|^2 >= sigma_min is proven or depth 40 is reached.
 * On success writes the proven lower bound of |w|^2 over [0,1].
 * Ambiguity at max depth is rejection (OP_PH_IRREGULAR). */
op_result op_regularity_certify_span(const op_c64 b[3], double sigma_min,
                                     double *min_w2_bound);

/* Whole-spline regularity with sigma_min = 1e-10 * sigma_ref,
 * sigma_ref = L_center / T (§8.7). */
op_result op_regularity_certify_spline(const op_spline *sp, double sigma_ref,
                                       double *min_w2_bound);

/* Certified signed-curvature range of one span by recursive Bernstein
 * interval subdivision of kappa = 2A/(h R^2) (§8.11): stop at width
 * 1e-12*max(1,|kappa|) or depth 48. */
op_result op_curvature_range_span(const op_span *sp,
                                  double *kappa_min, double *kappa_max);

/* Curvature-magnitude upper bound over a sub-interval [nu0, nu1] of a
 * span, by the §12.1 hull bound: K <= 2 max|A| / (h (min R)^2).
 * `refine` requests the binary64 recursive tightening (relative gap
 * <= 1e-8 or depth 32); refine==0 gives the one-shot hull bound. */
op_result op_curvature_bound_interval(const op_span *sp, double nu0, double nu1,
                                      int refine, double *k_bound);

/* Aggregate one-sided minimum curvature radii (§8.11):
 * rho_L = 1/max(kappa_max, 0), rho_R = 1/max(-kappa_min, 0), 1/0 = +inf. */
op_result op_curvature_radii(const op_spline *sp,
                             double *kappa_min, double *kappa_max,
                             double *rho_left, double *rho_right);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_REGULARITY_H */
