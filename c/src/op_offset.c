/* Optiline — exact degree-9 rational offsets and offset length
 * (PROJECT_SPECIFICATION.md §8.9, §8.10, §23.1).
 *
 * ISO C99 subset: no VLAs, no allocation; bounded recursion only.
 */
#include <math.h>
#include <string.h>

#include "optiline/op_complex.h"
#include "optiline/op_math.h"
#include "optiline/op_offset.h"
#include "optiline/op_span.h"

#define OP_OFFSET_MAX_DEPTH 24 /* §8.9 subdivision failure depth      */
#define OP_ANGLE_MAX_DEPTH  48 /* tangent-angle cone subdivision cap  */

static const double OP_PI = 3.14159265358979323846;
/* tan(0.25): cone half-angle test keeps every per-cell w-rotation
 * below 0.5 rad, so each theta step is below 1 rad < pi and the
 * principal atan2 value equals the continuous increment (§8.10).     */
static const double OP_TAN_QUARTER = 0.25534192122103627;

static double op_offset_quiet_nan(void) {
    uint64_t bits = 0x7FF8000000000000ull;
    double x;
    memcpy(&x, &bits, sizeof x);
    return x;
}

/* ------------------------------------------------------------------ */
/* §8.9: degree-9 products for one (sub)span. p is the degree-5       */
/* position control set of the piece; q and r are the degree-4        */
/* hodograph and speed coefficients of the piece preimage. Invalid    */
/* binomial indices contribute zero. Returns 1 when all W_k > 0.      */
/* ------------------------------------------------------------------ */
static int op_offset_products(const op_c64 p[6], const op_c64 q[5],
                              const double r[5], double d,
                              op_c64 H[10], double W[10]) {
    int all_positive = 1;
    int k, j;
    for (k = 0; k <= 9; k++) {
        double denom = op_binomial(9, k);
        op_c64 mk = op_c64_make(0.0, 0.0);
        op_c64 q9k = op_c64_make(0.0, 0.0);
        double wk = 0.0;
        for (j = 0; j <= 4; j++) {
            int i = k - j;
            double wgt;
            if (i < 0 || i > 5) continue;
            wgt = op_binomial(4, j) * op_binomial(5, i) / denom;
            wk += wgt * r[j];
            q9k = op_c64_add(q9k, op_c64_scale(q[j], wgt));
            mk = op_c64_add(mk, op_c64_scale(p[i], wgt * r[j]));
        }
        W[k] = wk;
        /* H_k = M_k + d i Q_k^{9} (§8.9). */
        H[k] = op_c64_add(mk, op_c64_scale(op_c64_muli(q9k), d));
        if (!(wk > 0.0)) all_positive = 0;
    }
    return all_positive;
}

/* Recursive §8.9 build over the source preimage: subdivide b and the
 * position controls exactly at 1/2 (the position split provides the
 * correct sub-span start points), recompile q/r from the sub-preimage,
 * and append records in curve order.                                   */
static op_result op_offset_build_rec(const op_c64 b[3], const op_c64 p[6],
                                     double u0, double u1, double d,
                                     int32_t src_span, int depth,
                                     op_offset_curve *curve) {
    op_span piece;
    op_c64 H[10];
    double W[10];
    int k;

    /* q and r of the sub-preimage come from the authoritative §8.4
     * product formulas; the position controls of op_span_compile are
     * not used for sub-spans (the exact split of p is).               */
    op_span_compile(&piece, b, op_c64_make(0.0, 0.0));

    if (op_offset_products(p, piece.q, piece.r, d, H, W)) {
        if (curve->count >= OP_MAX_OFFSET_SPANS)
            return OP_TRACK_CONSTRUCTION_FAILED;
        {
            op_offset_span *rec = &curve->spans[curve->count];
            for (k = 0; k < 10; k++) {
                rec->H[k] = H[k];
                rec->W[k] = W[k];
            }
            rec->u0 = u0;
            rec->u1 = u1;
            rec->src_span = src_span;
            rec->pad_ = 0;
            curve->count += 1;
        }
        return OP_OK;
    }

    if (depth >= OP_OFFSET_MAX_DEPTH) return OP_TRACK_CONSTRUCTION_FAILED;

    {
        op_c64 bl[3], br[3], pl[6], pr[6];
        double um = 0.5 * (u0 + u1);
        op_result rc;
        op_decasteljau_split_c(b, 2, 0.5, bl, br);
        op_decasteljau_split_c(p, 5, 0.5, pl, pr);
        rc = op_offset_build_rec(bl, pl, u0, um, d, src_span, depth + 1, curve);
        if (rc != OP_OK) return rc;
        return op_offset_build_rec(br, pr, um, u1, d, src_span, depth + 1, curve);
    }
}

op_result op_offset_span_build(const op_span *sp, int32_t span_index, double d,
                               op_offset_curve *curve) {
    int k;
    if (sp == NULL || curve == NULL || !op_is_finite(d)) return OP_INVALID_INPUT;
    for (k = 0; k < 3; k++) {
        if (!op_c64_is_finite(sp->b[k])) return OP_INVALID_INPUT;
    }
    for (k = 0; k < 6; k++) {
        if (!op_c64_is_finite(sp->p[k])) return OP_INVALID_INPUT;
    }
    return op_offset_build_rec(sp->b, sp->p, 0.0, 1.0, d, span_index, 0, curve);
}

/* ------------------------------------------------------------------ */
/* §8.10: continuously accumulated tangent-angle increment.           */
/* theta = 2 arg(w). Each cell is certified to keep w inside a cone   */
/* of half-angle 0.25 rad around a reference direction, so the w      */
/* rotation per cell is below 0.5 rad and the endpoint atan2 step is  */
/* the exact continuous increment. Never a difference of two          */
/* independently wrapped angles.                                      */
/* ------------------------------------------------------------------ */
static int op_angle_rec(const op_c64 d[3], int depth, op_neumaier *acc) {
    op_c64 u = op_c64_add(op_c64_add(d[0], d[1]), d[2]);
    int inside = 1;
    int k;
    for (k = 0; k < 3; k++) {
        double dt = op_c64_dot(u, d[k]);
        double cr = op_c64_cross(u, d[k]);
        if (!(dt > 0.0) || !(fabs(cr) <= OP_TAN_QUARTER * dt)) {
            inside = 0;
            break;
        }
    }
    if (inside) {
        /* Bezier endpoint controls are exact w values at the cell ends. */
        double step = atan2(op_c64_cross(d[0], d[2]), op_c64_dot(d[0], d[2]));
        op_neumaier_add(acc, step);
        return 1;
    }
    if (depth >= OP_ANGLE_MAX_DEPTH) return 0;
    {
        op_c64 left[3], right[3];
        op_decasteljau_split_c(d, 2, 0.5, left, right);
        if (!op_angle_rec(left, depth + 1, acc)) return 0;
        return op_angle_rec(right, depth + 1, acc);
    }
}

double op_span_tangent_angle_increment(const op_span *sp, double nu0, double nu1) {
    op_c64 cell[3], tmp[3];
    op_neumaier acc;
    double lo, hi, sign;
    int k;

    if (sp == NULL || !op_is_finite(nu0) || !op_is_finite(nu1))
        return op_offset_quiet_nan();
    if (nu0 == nu1) return 0.0;
    if (nu0 < nu1) {
        lo = nu0;
        hi = nu1;
        sign = 1.0;
    } else {
        lo = nu1;
        hi = nu0;
        sign = -1.0;
    }
    if (!(0.0 <= lo && hi <= 1.0)) return op_offset_quiet_nan();
    for (k = 0; k < 3; k++) {
        if (!op_c64_is_finite(sp->b[k])) return op_offset_quiet_nan();
    }

    /* Restrict the quadratic preimage to [lo, hi]. */
    if (lo > 0.0) {
        op_decasteljau_split_c(sp->b, 2, lo, tmp, cell);
    } else {
        for (k = 0; k < 3; k++) cell[k] = sp->b[k];
    }
    if (hi < 1.0) {
        double t = (hi - lo) / (1.0 - lo);
        for (k = 0; k < 3; k++) tmp[k] = cell[k];
        op_decasteljau_split_c(tmp, 2, t, cell, tmp);
    }

    op_neumaier_init(&acc);
    if (!op_angle_rec(cell, 0, &acc)) return op_offset_quiet_nan();
    /* theta = 2 arg(w): double the accumulated w-angle sum. */
    return sign * 2.0 * op_neumaier_value(&acc);
}

/* ------------------------------------------------------------------ */
/* §8.9 + §8.10: whole-curve build and exact offset length.           */
/* ------------------------------------------------------------------ */
op_result op_offset_curve_build(const op_spline *sp, double d, int turning,
                                op_offset_curve *curve) {
    op_neumaier theta;
    double dtheta, target;
    int32_t j;

    if (sp == NULL || curve == NULL || !op_is_finite(d)) return OP_INVALID_INPUT;
    if (turning != 1 && turning != -1) return OP_INVALID_INPUT;

    curve->count = 0;
    curve->pad_ = 0;
    curve->signed_d = d;
    curve->length = 0.0;

    op_neumaier_init(&theta);
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        double inc;
        op_result rc = op_offset_span_build(&sp->span[j], j, d, curve);
        if (rc != OP_OK) return rc;
        inc = op_span_tangent_angle_increment(&sp->span[j], 0.0, 1.0);
        if (!op_is_finite(inc)) return OP_PH_IRREGULAR;
        op_neumaier_add(&theta, inc);
    }

    /* The accumulated tangent-angle increment of a simple closed loop
     * must equal 2 pi n_T (§8.10).                                     */
    dtheta = op_neumaier_value(&theta);
    target = 2.0 * OP_PI * (double)turning;
    if (!(fabs(dtheta - target) <= 1e-6)) return OP_INVALID_INPUT;

    curve->length = sp->total_len - 2.0 * OP_PI * (double)turning * d;
    if (!op_is_finite(curve->length)) return OP_INVALID_INPUT;
    return OP_OK;
}

/* ------------------------------------------------------------------ */
/* Rational evaluation: point = H(u)/W(u), all W_k > 0 on [0,1].      */
/* ------------------------------------------------------------------ */
op_c64 op_offset_span_point(const op_offset_span *os, double u) {
    op_c64 h = op_decasteljau_c(os->H, 9, u);
    double w = op_decasteljau_d(os->W, 9, u);
    return op_c64_scale(h, 1.0 / w);
}
