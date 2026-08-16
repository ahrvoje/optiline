/* Optiline — playback-only arc-length inverse (§8.8).
 *
 * BUILD BOUNDARY: the only implementation lives in the separate
 * translation unit c/src/op_playback_inverse.c. No optimizer,
 * track-compiler, or certification target may link that object; only the
 * playback reactor and playback tests do (§8.8, §24.1). Keeping this
 * header out of certifier sources is checked by the link-map test.
 */
#ifndef OPTILINE_OP_PLAYBACK_H
#define OPTILINE_OP_PLAYBACK_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 16-cell monotone LUT for one span (§8.8), built once per compiled span
 * in the playback module only. */
typedef struct op_arc_lut { double s[17]; } op_arc_lut;

void op_playback_build_lut(const op_span *sp, op_arc_lut *lut);

/* Bracketed-Newton inverse: target s in [0, L] -> nu in [0,1].
 * Endpoint exactness, reverse polynomial for s > L/2, seed from LUT,
 * <= 12 Newton/bisection steps then <= 52 pure bisections; binary64
 * acceptance |S(nu)-s| <= 64 eps L + 4 ulp(s). */
op_result op_arc_length_inverse(const op_span *sp, const op_arc_lut *lut,
                                double s, double *nu);

/* Diagnostic point-at-distance over the whole spline (playback module
 * only): global distance -> span index + local nu + point. */
op_result op_point_at_distance(const op_spline *sp, const op_arc_lut lut[OP_SPAN_COUNT],
                               double s, int32_t *span_index, double *nu,
                               op_c64 *point);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_PLAYBACK_H */
