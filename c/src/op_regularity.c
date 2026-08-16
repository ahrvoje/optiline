/* Optiline — regularity and curvature-bound certificates
 * (PROJECT_SPECIFICATION.md §8.7, §8.11, §12.1, §23.1).
 *
 * ISO C99 subset: no VLAs, no allocation; explicit fixed-size stacks.
 * Ambiguity is rejection, never acceptance.
 */
#include <math.h>

#include "optiline/op_complex.h"
#include "optiline/op_math.h"
#include "optiline/op_regularity.h"
#include "optiline/op_span.h"

#define OP_REG_MAX_DEPTH  40 /* §8.7 binary64 depth limit  */
#define OP_KAPPA_C (2.0 / OP_SPAN_H) /* kappa = OP_KAPPA_C * A / R^2 */
#define OP_CURV_MAX_DEPTH 48 /* §8.11 depth limit          */
#define OP_KB_MAX_DEPTH   32 /* §12.1 refine depth limit   */

/* DFS pushes at most one pending sibling per level, so depth+1 entries
 * bound the stack; the sizes below add slack and are checked anyway.   */
#define OP_REG_STACK  (OP_REG_MAX_DEPTH + 8)
#define OP_CURV_STACK (OP_CURV_MAX_DEPTH + 8)

/* dist(0,[a,b]) from §8.7. */
static double op_dist0(double a, double b) {
    if (a > 0.0) return a;
    if (b < 0.0) return -b;
    return 0.0;
}

/* Axis-aligned hull distance-to-origin squared lower bound D^2 (§8.7). */
static double op_hull_dist2(const op_c64 d[3]) {
    double xlo = d[0].re, xhi = d[0].re;
    double ylo = d[0].im, yhi = d[0].im;
    double dx, dy;
    int k;
    for (k = 1; k < 3; k++) {
        if (d[k].re < xlo) xlo = d[k].re;
        if (d[k].re > xhi) xhi = d[k].re;
        if (d[k].im < ylo) ylo = d[k].im;
        if (d[k].im > yhi) yhi = d[k].im;
    }
    dx = op_dist0(xlo, xhi);
    dy = op_dist0(ylo, yhi);
    return dx * dx + dy * dy;
}

/* ------------------------------------------------------------------ */
/* §8.7 binary64 regularity certificate for one span.                 */
/* ------------------------------------------------------------------ */
typedef struct op_reg_cell {
    op_c64 d[3];
    int32_t depth;
} op_reg_cell;

op_result op_regularity_certify_span(const op_c64 b[3], double sigma_min,
                                     double *min_w2_bound) {
    op_reg_cell stack[OP_REG_STACK];
    int32_t top = 0;
    double proven_min = HUGE_VAL;
    int k;

    if (b == NULL || min_w2_bound == NULL) return OP_INVALID_INPUT;
    if (!op_is_finite(sigma_min) || !(sigma_min > 0.0)) return OP_INVALID_INPUT;
    for (k = 0; k < 3; k++) {
        if (!op_c64_is_finite(b[k])) return OP_INVALID_INPUT;
    }

    stack[0].d[0] = b[0];
    stack[0].d[1] = b[1];
    stack[0].d[2] = b[2];
    stack[0].depth = 0;
    top = 1;

    while (top > 0) {
        op_reg_cell cell = stack[--top];
        double d2 = op_hull_dist2(cell.d);
        if (d2 >= sigma_min) {
            if (d2 < proven_min) proven_min = d2;
            continue;
        }
        if (cell.depth >= OP_REG_MAX_DEPTH) return OP_PH_IRREGULAR;
        if (top + 2 > OP_REG_STACK) return OP_PH_IRREGULAR; /* unreachable */
        {
            op_c64 left[3], right[3];
            op_decasteljau_split_c(cell.d, 2, 0.5, left, right);
            stack[top].d[0] = right[0];
            stack[top].d[1] = right[1];
            stack[top].d[2] = right[2];
            stack[top].depth = cell.depth + 1;
            top++;
            stack[top].d[0] = left[0];
            stack[top].d[1] = left[1];
            stack[top].d[2] = left[2];
            stack[top].depth = cell.depth + 1;
            top++;
        }
    }

    *min_w2_bound = proven_min;
    return OP_OK;
}

op_result op_regularity_certify_spline(const op_spline *sp, double sigma_ref,
                                       double *min_w2_bound) {
    double sigma_min, global_min = HUGE_VAL;
    int32_t j;
    if (sp == NULL || min_w2_bound == NULL) return OP_INVALID_INPUT;
    if (!op_is_finite(sigma_ref) || !(sigma_ref > 0.0)) return OP_INVALID_INPUT;
    sigma_min = 1e-10 * sigma_ref;
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        double span_min = 0.0;
        op_result rc = op_regularity_certify_span(sp->span[j].b, sigma_min,
                                                  &span_min);
        if (rc != OP_OK) return rc;
        if (span_min < global_min) global_min = span_min;
    }
    *min_w2_bound = global_min;
    return OP_OK;
}

/* ------------------------------------------------------------------ */
/* §8.11 certified signed-curvature range: kappa = 2A/(h R^2) with    */
/* numerator A degree 3 and denominator R = |w|^2 degree 4, bounded   */
/* by Bernstein coefficient hulls with branch-and-bound subdivision.  */
/* ------------------------------------------------------------------ */
typedef struct op_curv_cell {
    double A[4];
    double R[5];
    int32_t depth;
} op_curv_cell;

static void op_minmax_d(const double *v, int n, double *lo, double *hi) {
    double a = v[0], b = v[0];
    int i;
    for (i = 1; i < n; i++) {
        if (v[i] < a) a = v[i];
        if (v[i] > b) b = v[i];
    }
    *lo = a;
    *hi = b;
}

/* Interval of kappa = (2/h) A/R^2 from A in [alo,ahi], R in [rlo,rhi],
 * rlo > 0 required by the caller.                                      */
static void op_kappa_interval(double alo, double ahi, double rlo, double rhi,
                              double *klo, double *khi) {
    double slo = rlo * rlo, shi = rhi * rhi;
    *klo = OP_KAPPA_C * ((alo >= 0.0) ? alo / shi : alo / slo);
    *khi = OP_KAPPA_C * ((ahi >= 0.0) ? ahi / slo : ahi / shi);
}

op_result op_curvature_range_span(const op_span *sp,
                                  double *kappa_min, double *kappa_max) {
    op_curv_cell stack[OP_CURV_STACK];
    int32_t top = 0;
    double best_lo = HUGE_VAL;  /* smallest sampled (achievable) kappa  */
    double best_hi = -HUGE_VAL; /* largest sampled (achievable) kappa   */
    double res_lo = HUGE_VAL;   /* certified outer minimum              */
    double res_hi = -HUGE_VAL;  /* certified outer maximum              */
    int k;

    if (sp == NULL || kappa_min == NULL || kappa_max == NULL)
        return OP_INVALID_INPUT;
    op_span_a_coeffs(sp, stack[0].A);
    for (k = 0; k < 4; k++) {
        if (!op_is_finite(stack[0].A[k])) return OP_INVALID_INPUT;
    }
    for (k = 0; k < 5; k++) {
        if (!op_is_finite(sp->r[k])) return OP_INVALID_INPUT;
        stack[0].R[k] = sp->r[k];
    }
    stack[0].depth = 0;
    top = 1;

    while (top > 0) {
        op_curv_cell cell = stack[--top];
        double alo, ahi, rlo, rhi;
        int settled = 0;
        op_minmax_d(cell.A, 4, &alo, &ahi);
        op_minmax_d(cell.R, 5, &rlo, &rhi);

        /* Endpoint Bernstein coefficients are exact function values, so
         * kappa at both cell ends is an achievable sample.               */
        if (cell.R[0] > 0.0) {
            double ks = OP_KAPPA_C * cell.A[0] / (cell.R[0] * cell.R[0]);
            if (ks < best_lo) best_lo = ks;
            if (ks > best_hi) best_hi = ks;
        }
        if (cell.R[4] > 0.0) {
            double ke = OP_KAPPA_C * cell.A[3] / (cell.R[4] * cell.R[4]);
            if (ke < best_lo) best_lo = ke;
            if (ke > best_hi) best_hi = ke;
        }

        if (rlo > 0.0) {
            double klo, khi, tol, scale;
            op_kappa_interval(alo, ahi, rlo, rhi, &klo, &khi);
            scale = 1.0;
            if (best_hi > -HUGE_VAL && fabs(best_hi) > scale) scale = fabs(best_hi);
            if (best_lo < HUGE_VAL && fabs(best_lo) > scale) scale = fabs(best_lo);
            tol = 1e-12 * scale; /* §8.11: 1e-12 max(1,|kappa|) */
            if (khi - klo <= tol ||
                (khi <= best_hi + tol && klo >= best_lo - tol)) {
                if (klo < res_lo) res_lo = klo;
                if (khi > res_hi) res_hi = khi;
                settled = 1;
            }
        } else if (cell.depth >= OP_CURV_MAX_DEPTH) {
            /* Denominator hull cannot be proven positive: irregular.  */
            return OP_PH_IRREGULAR;
        }

        if (settled) continue;
        if (cell.depth >= OP_CURV_MAX_DEPTH) return OP_TRACK_CONSTRUCTION_FAILED;
        if (top + 2 > OP_CURV_STACK) return OP_TRACK_CONSTRUCTION_FAILED;
        {
            double al[4], ar[4], rl[5], rr[5];
            op_decasteljau_split_d(cell.A, 3, 0.5, al, ar);
            op_decasteljau_split_d(cell.R, 4, 0.5, rl, rr);
            for (k = 0; k < 4; k++) {
                stack[top].A[k] = ar[k];
                stack[top + 1].A[k] = al[k];
            }
            for (k = 0; k < 5; k++) {
                stack[top].R[k] = rr[k];
                stack[top + 1].R[k] = rl[k];
            }
            stack[top].depth = cell.depth + 1;
            stack[top + 1].depth = cell.depth + 1;
            top += 2;
        }
    }

    *kappa_min = res_lo;
    *kappa_max = res_hi;
    return OP_OK;
}

/* ------------------------------------------------------------------ */
/* §12.1 curvature-magnitude upper bound over a sub-interval:         */
/* K <= 2 max|A| / (h (min R)^2) with hull bounds; refine mode        */
/* subdivides until the relative gap is <= 1e-8 or depth 32.          */
/* ------------------------------------------------------------------ */
static double op_max_abs4(const double a[4]) {
    double m = fabs(a[0]);
    int k;
    for (k = 1; k < 4; k++) {
        double v = fabs(a[k]);
        if (v > m) m = v;
    }
    return m;
}

static op_result op_kbound_rec(const double A[4], const double R[5],
                               int depth, double *best_sample, double *bound) {
    double rlo, rhi, u;
    op_minmax_d(R, 5, &rlo, &rhi);

    /* Achievable |kappa| samples at cell endpoints. */
    if (R[0] > 0.0) {
        double v = fabs(OP_KAPPA_C * A[0] / (R[0] * R[0]));
        if (v > *best_sample) *best_sample = v;
    }
    if (R[4] > 0.0) {
        double v = fabs(OP_KAPPA_C * A[3] / (R[4] * R[4]));
        if (v > *best_sample) *best_sample = v;
    }

    if (rlo > 0.0) {
        u = OP_KAPPA_C * op_max_abs4(A) / (rlo * rlo);
        if (u <= *best_sample + 1e-8 * ((*best_sample > 1.0) ? *best_sample : 1.0)) {
            *bound = u;
            return OP_OK;
        }
        if (depth >= OP_KB_MAX_DEPTH) {
            *bound = u; /* still a certified upper bound, just not tight */
            return OP_OK;
        }
    } else if (depth >= OP_KB_MAX_DEPTH) {
        return OP_PH_IRREGULAR;
    }

    {
        double al[4], ar[4], rl[5], rr[5];
        double bl = 0.0, br = 0.0;
        op_result rc;
        op_decasteljau_split_d(A, 3, 0.5, al, ar);
        op_decasteljau_split_d(R, 4, 0.5, rl, rr);
        rc = op_kbound_rec(al, rl, depth + 1, best_sample, &bl);
        if (rc != OP_OK) return rc;
        rc = op_kbound_rec(ar, rr, depth + 1, best_sample, &br);
        if (rc != OP_OK) return rc;
        *bound = (bl > br) ? bl : br;
        return OP_OK;
    }
}

op_result op_curvature_bound_interval(const op_span *sp, double nu0, double nu1,
                                      int refine, double *k_bound) {
    double afull[4], rfull[5], asub[4], rsub[5], tmpa[4], tmpr[5];
    int k;

    if (sp == NULL || k_bound == NULL) return OP_INVALID_INPUT;
    if (!op_is_finite(nu0) || !op_is_finite(nu1)) return OP_INVALID_INPUT;
    if (!(0.0 <= nu0 && nu0 < nu1 && nu1 <= 1.0)) return OP_INVALID_INPUT;

    op_span_a_coeffs(sp, afull);
    for (k = 0; k < 4; k++) {
        if (!op_is_finite(afull[k])) return OP_INVALID_INPUT;
    }
    for (k = 0; k < 5; k++) {
        if (!op_is_finite(sp->r[k])) return OP_INVALID_INPUT;
        rfull[k] = sp->r[k];
    }

    /* Restrict both polynomials to [nu0, nu1] by two de Casteljau splits. */
    if (nu0 > 0.0) {
        op_decasteljau_split_d(afull, 3, nu0, tmpa, asub);
        op_decasteljau_split_d(rfull, 4, nu0, tmpr, rsub);
    } else {
        for (k = 0; k < 4; k++) asub[k] = afull[k];
        for (k = 0; k < 5; k++) rsub[k] = rfull[k];
    }
    if (nu1 < 1.0) {
        double t = (nu1 - nu0) / (1.0 - nu0);
        for (k = 0; k < 4; k++) tmpa[k] = asub[k];
        for (k = 0; k < 5; k++) tmpr[k] = rsub[k];
        op_decasteljau_split_d(tmpa, 3, t, asub, tmpa);
        op_decasteljau_split_d(tmpr, 4, t, rsub, tmpr);
    }

    if (!refine) {
        double rlo, rhi;
        op_minmax_d(rsub, 5, &rlo, &rhi);
        if (!(rlo > 0.0)) return OP_PH_IRREGULAR;
        *k_bound = OP_KAPPA_C * op_max_abs4(asub) / (rlo * rlo);
        return OP_OK;
    }

    {
        double best = 0.0, bound = 0.0;
        op_result rc = op_kbound_rec(asub, rsub, 0, &best, &bound);
        if (rc != OP_OK) return rc;
        *k_bound = bound;
        return OP_OK;
    }
}

/* ------------------------------------------------------------------ */
/* §8.11 aggregated one-sided minimum curvature radii, 1/0 = +inf.    */
/* ------------------------------------------------------------------ */
op_result op_curvature_radii(const op_spline *sp,
                             double *kappa_min, double *kappa_max,
                             double *rho_left, double *rho_right) {
    double kmin = HUGE_VAL, kmax = -HUGE_VAL;
    int32_t j;
    if (sp == NULL || kappa_min == NULL || kappa_max == NULL ||
        rho_left == NULL || rho_right == NULL) {
        return OP_INVALID_INPUT;
    }
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        double lo = 0.0, hi = 0.0;
        op_result rc = op_curvature_range_span(&sp->span[j], &lo, &hi);
        if (rc != OP_OK) return rc;
        if (lo < kmin) kmin = lo;
        if (hi > kmax) kmax = hi;
    }
    *kappa_min = kmin;
    *kappa_max = kmax;
    /* rho_L = 1/max(kappa_max, 0), rho_R = 1/max(-kappa_min, 0). */
    *rho_left = (kmax > 0.0) ? 1.0 / kmax : HUGE_VAL;
    *rho_right = (kmin < 0.0) ? 1.0 / (-kmin) : HUGE_VAL;
    return OP_OK;
}
