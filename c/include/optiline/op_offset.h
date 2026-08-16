/* Optiline — exact rational offsets and offset length (§8.9, §8.10). */
#ifndef OPTILINE_OP_OFFSET_H
#define OPTILINE_OP_OFFSET_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Build the degree-9 homogeneous offset controls for one span at signed
 * left distance d (§8.9). If any weight W_k <= 0, subdivide the source
 * preimage exactly at 1/2 and rebuild; failure by depth 24 is a
 * construction error (OP_TRACK_CONSTRUCTION_FAILED).
 * Appends resulting spans to `curve` (caller sets curve->count=0 first). */
op_result op_offset_span_build(const op_span *sp, int32_t span_index, double d,
                               op_offset_curve *curve);

/* Build the complete offset curve for all 128 spans and compute its exact
 * length L_d = L - 2*pi*n_T*d with the continuously accumulated
 * tangent-angle rule (§8.10). turning must be +1 or -1. */
op_result op_offset_curve_build(const op_spline *sp, double d, int turning,
                                op_offset_curve *curve);

/* Evaluate one offset span at local u in [0,1]: point = H(u)/W(u). */
op_c64 op_offset_span_point(const op_offset_span *os, double u);

/* Continuously unwrapped tangent-angle increment over a span interval by
 * atan2(cross,dot) accumulation over preimage subdivision cells (§8.10);
 * never a difference of two independently wrapped angles. */
double op_span_tangent_angle_increment(const op_span *sp, double nu0, double nu1);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_OFFSET_H */
