/* Optiline — simplicity certificates (§9.10, Appendix B.2). */
#ifndef OPTILINE_OP_SELFINT_H
#define OPTILINE_OP_SELFINT_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Binary64 no-self-intersection certificate for the whole racing line:
 * every overlapping span pair to depth 48 with bivariate Bernstein
 * subdivision, remaining boxes resolved by 2D interval Newton (§9.10).
 * Adjacent spans may share only the prescribed endpoint; same-span test
 * uses the half-domain 0 <= u < v <= 1. */
op_result op_selfint_certify_spline(const op_spline *sp);

/* Pairwise test exposed for unit tests. `adjacent` in {-1,0,+1}:
 * 0 = nonadjacent (any root fails), +1 = q follows p (shared endpoint
 * p(1)=q(0) allowed), -1 = p follows q. `same_span` tests one span
 * against itself. */
op_result op_selfint_test_pair(const op_c64 p[6], const op_c64 q[6],
                               int adjacent, int same_span);

/* Rational-span intersection test used by the track compiler between the
 * exact left and right boundaries (Appendix B.2); no roots allowed. */
op_result op_selfint_test_rational_pair(const op_c64 h1[10], const double w1[10],
                                        const op_c64 h2[10], const double w2[10],
                                        int adjacent);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_SELFINT_H */
