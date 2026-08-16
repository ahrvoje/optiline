/* Optiline — playback-only monotone quintic arc-length inverse (§8.8). */
#include <float.h>
#include <math.h>

#include "optiline/op_math.h"
#include "optiline/op_playback.h"
#include "optiline/op_span.h"

#define OP_LUT_CELLS 16
#define OP_NEWTON_STEPS 12
#define OP_BISECT_STEPS 52

void op_playback_build_lut(const op_span *sp, op_arc_lut *lut) {
    int i;
    if (sp == NULL || lut == NULL) return;
    for (i = 0; i <= OP_LUT_CELLS; i++) {
        lut->s[i] = op_span_arc_forward(sp, (double)i / OP_LUT_CELLS);
    }
}

static double op_arc_value(const op_span *sp, double u, int reverse) {
    return reverse ? op_span_arc_reverse(sp, u) : op_span_arc_forward(sp, u);
}

static double op_arc_speed(const op_span *sp, double u, int reverse) {
    double x = reverse ? 1.0 - u : u;
    return OP_SPAN_H * op_decasteljau_d(sp->r, 4, x);
}

op_result op_arc_length_inverse(const op_span *sp, const op_arc_lut *lut,
                                double s, double *nu) {
    double target, lo, hi, u, f, tol;
    int reverse, cell, iter;
    if (sp == NULL || lut == NULL || nu == NULL || !op_is_finite(s) ||
        !(sp->len > 0.0) || s < 0.0 || s > sp->len) return OP_INVALID_INPUT;
    if (s == 0.0) { *nu = 0.0; return OP_OK; }
    if (s == sp->len) { *nu = 1.0; return OP_OK; }

    reverse = s > 0.5 * sp->len;
    target = reverse ? sp->len - s : s;
    cell = 0;
    while (cell + 1 < OP_LUT_CELLS) {
        double upper = reverse
            ? sp->len - lut->s[OP_LUT_CELLS - cell - 1]
            : lut->s[cell + 1];
        if (upper >= target) break;
        cell++;
    }
    lo = (double)cell / OP_LUT_CELLS;
    hi = (double)(cell + 1) / OP_LUT_CELLS;
    {
        double slo = op_arc_value(sp, lo, reverse);
        double shi = op_arc_value(sp, hi, reverse);
        double t = (target - slo) / (shi - slo);
        if (!op_is_finite(t) || t <= 0.0 || t >= 1.0) t = 0.5;
        u = lo + (hi - lo) * t;
    }
    tol = 64.0 * DBL_EPSILON * sp->len + 4.0 * op_ulp(target);
    for (iter = 0; iter < OP_NEWTON_STEPS + OP_BISECT_STEPS; iter++) {
        double candidate;
        f = op_arc_value(sp, u, reverse) - target;
        if (fabs(f) <= tol) {
            *nu = reverse ? 1.0 - u : u;
            return OP_OK;
        }
        if (f > 0.0) hi = u; else lo = u;
        if (iter < OP_NEWTON_STEPS) {
            double speed = op_arc_speed(sp, u, reverse);
            candidate = u - f / speed;
            if (!op_is_finite(candidate) || !(candidate > lo && candidate < hi))
                candidate = 0.5 * (lo + hi);
        } else {
            candidate = 0.5 * (lo + hi);
        }
        u = candidate;
    }
    return OP_PLAYBACK_ARC_LENGTH_INVERSION_FAILED;
}

op_result op_point_at_distance(const op_spline *sp,
                               const op_arc_lut lut[OP_SPAN_COUNT], double s,
                               int32_t *span_index, double *nu, op_c64 *point) {
    int32_t lo, hi, mid, j;
    double local;
    op_result rc;
    if (sp == NULL || lut == NULL || span_index == NULL || nu == NULL ||
        point == NULL || !op_is_finite(s) || s < 0.0 || s > sp->total_len)
        return OP_INVALID_INPUT;
    if (s == sp->total_len) {
        j = OP_SPAN_COUNT - 1;
        local = sp->span[j].len;
    } else {
        lo = 0;
        hi = OP_SPAN_COUNT;
        while (lo + 1 < hi) {
            mid = lo + (hi - lo) / 2;
            if (sp->cum_len[mid] <= s) lo = mid; else hi = mid;
        }
        j = lo;
        local = s - sp->cum_len[j];
    }
    rc = op_arc_length_inverse(&sp->span[j], &lut[j], local, nu);
    if (rc != OP_OK) return rc;
    *span_index = j;
    *point = op_span_point(&sp->span[j], *nu);
    return OP_OK;
}
