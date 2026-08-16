/* Optiline — quintic PH span compilation and evaluation
 * (PROJECT_SPECIFICATION.md §5.4, §8.3–§8.6, §9.2, §12.1).
 *
 * ISO C99 subset: no VLAs, no <complex.h>, no allocation.
 */
#include <math.h>

#include "optiline/op_complex.h"
#include "optiline/op_construction.h" /* OP_GRAM (defined in op_construction.c) */
#include "optiline/op_math.h"
#include "optiline/op_span.h"

const double OP_GRAM[9] = {
    0.2, 0.1, 0.0333333333333333333333333333333333,
    0.1, 0.133333333333333333333333333333333, 0.1,
    0.0333333333333333333333333333333333, 0.1, 0.2
};

/* ------------------------------------------------------------------ */
/* §8.3: extract span j preimage controls with the §5.4 antiperiodic  */
/* rule: b0=(c_{j-1}+c_j)/2, b1=c_j, b2=(c_j+c_{j+1})/2.              */
/* ------------------------------------------------------------------ */
void op_span_extract_preimage(const op_c64 *c, int32_t j, op_c64 b[3]) {
    op_c64 cm, c0, cp;
    if (c == NULL || b == NULL) return;
    cm = op_antiperiodic_control(c, j - 1, OP_SPAN_COUNT);
    c0 = op_antiperiodic_control(c, j, OP_SPAN_COUNT);
    cp = op_antiperiodic_control(c, j + 1, OP_SPAN_COUNT);
    b[0] = op_c64_scale(op_c64_add(cm, c0), 0.5);
    b[1] = c0;
    b[2] = op_c64_scale(op_c64_add(c0, cp), 0.5);
}

/* ------------------------------------------------------------------ */
/* §8.4–§8.5: hodograph q, EXPLICIT REAL speed r, position p, arc sA. */
/* ------------------------------------------------------------------ */
void op_span_compile(op_span *sp, const op_c64 b[3], op_c64 p0) {
    const double h5 = OP_SPAN_H / 5.0;
    int k;
    if (sp == NULL || b == NULL) return;

    sp->b[0] = b[0];
    sp->b[1] = b[1];
    sp->b[2] = b[2];

    /* Degree-4 hodograph Bernstein coefficients (§8.4). */
    sp->q[0] = op_c64_mul(b[0], b[0]);
    sp->q[1] = op_c64_mul(b[0], b[1]);
    sp->q[2] = op_c64_scale(
        op_c64_add(op_c64_mul(b[0], b[2]),
                   op_c64_scale(op_c64_mul(b[1], b[1]), 2.0)),
        1.0 / 3.0);
    sp->q[3] = op_c64_mul(b[1], b[2]);
    sp->q[4] = op_c64_mul(b[2], b[2]);

    /* Explicit real degree-4 speed coefficients (§8.4). A complex r with a
     * discarded imaginary part is nonconforming.                          */
    sp->r[0] = op_c64_abs2(b[0]);
    sp->r[1] = op_c64_dot(b[0], b[1]);
    sp->r[2] = (op_c64_dot(b[0], b[2]) + 2.0 * op_c64_abs2(b[1])) / 3.0;
    sp->r[3] = op_c64_dot(b[1], b[2]);
    sp->r[4] = op_c64_abs2(b[2]);

    /* §8.5: p_{k+1} = p_k + (h/5) q_k and A_{k+1} = A_k + (h/5) r_k. */
    sp->p[0] = p0;
    sp->sA[0] = 0.0;
    for (k = 0; k < 5; k++) {
        sp->p[k + 1] = op_c64_add(sp->p[k], op_c64_scale(sp->q[k], h5));
        sp->sA[k + 1] = sp->sA[k] + h5 * sp->r[k];
    }
    sp->len = sp->sA[5];
}

/* ------------------------------------------------------------------ */
/* §9.2: exact span displacement Phi(b) = h b^T G b (no conjugation). */
/* OP_GRAM is the exact quadratic Bernstein Gram matrix, row-major.   */
/* ------------------------------------------------------------------ */
op_c64 op_span_displacement(const op_c64 b[3]) {
    op_c64 acc = op_c64_make(0.0, 0.0);
    int k, a;
    if (b == NULL) return acc;
    for (k = 0; k < 3; k++) {
        op_c64 row = op_c64_make(0.0, 0.0);
        for (a = 0; a < 3; a++) {
            row = op_c64_add(row, op_c64_scale(b[a], OP_GRAM[3 * k + a]));
        }
        acc = op_c64_add(acc, op_c64_mul(b[k], row));
    }
    return op_c64_scale(acc, OP_SPAN_H);
}

/* ------------------------------------------------------------------ */
/* Whole-spline compilation (§9.2 start-point rule + Neumaier sums).  */
/* ------------------------------------------------------------------ */
op_result op_spline_compile(op_spline *sp, const op_c64 gate_points[OP_GATE_COUNT]) {
    op_neumaier acc;
    int32_t i, j;
    if (sp == NULL || gate_points == NULL) return OP_INVALID_INPUT;
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        if (!op_c64_is_finite(sp->c[j])) return OP_INVALID_INPUT;
    }
    for (i = 0; i < OP_GATE_COUNT; i++) {
        if (!op_c64_is_finite(gate_points[i])) return OP_INVALID_INPUT;
    }

    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 b_even[3], b_odd[3], phi;
        op_span_extract_preimage(sp->c, 2 * i, b_even);
        op_span_extract_preimage(sp->c, 2 * i + 1, b_odd);
        phi = op_span_displacement(b_even);
        /* §9.2: p_{2i,0} = P_i and p_{2i+1,0} = P_i + Phi(b_{2i}). */
        op_span_compile(&sp->span[2 * i], b_even, gate_points[i]);
        op_span_compile(&sp->span[2 * i + 1], b_odd,
                        op_c64_add(gate_points[i], phi));
    }

    op_neumaier_init(&acc);
    sp->cum_len[0] = 0.0;
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        op_neumaier_add(&acc, sp->span[j].len);
        sp->cum_len[j + 1] = op_neumaier_value(&acc);
    }
    sp->total_len = sp->cum_len[OP_SPAN_COUNT];
    if (!op_is_finite(sp->total_len)) return OP_INVALID_INPUT;
    return OP_OK;
}

/* ------------------------------------------------------------------ */
/* Evaluation (§8.3–§8.6). All authoritative Bernstein evaluation is  */
/* de Casteljau (§23.1).                                              */
/* ------------------------------------------------------------------ */
op_c64 op_span_point(const op_span *sp, double nu) {
    return op_decasteljau_c(sp->p, 5, nu);
}

op_c64 op_span_dz(const op_span *sp, double nu) {
    /* dz/dnu = h sum q_k B_k^4 (§8.4). */
    return op_c64_scale(op_decasteljau_c(sp->q, 4, nu), OP_SPAN_H);
}

op_c64 op_span_preimage(const op_span *sp, double nu) {
    return op_decasteljau_c(sp->b, 2, nu);
}

op_c64 op_span_preimage_dnu(const op_span *sp, double nu) {
    /* w_nu = 2[(b1-b0)(1-nu) + (b2-b1)nu] (§8.3). */
    op_c64 d[2];
    d[0] = op_c64_scale(op_c64_sub(sp->b[1], sp->b[0]), 2.0);
    d[1] = op_c64_scale(op_c64_sub(sp->b[2], sp->b[1]), 2.0);
    return op_decasteljau_c(d, 1, nu);
}

op_result op_span_frame(const op_span *sp, double nu,
                        op_c64 *tangent, op_c64 *normal_left, double *kappa) {
    op_c64 w, wnu, t;
    double m, r2, a, b;
    if (sp == NULL || !op_is_finite(nu)) return OP_INVALID_INPUT;
    w = op_span_preimage(sp, nu);
    wnu = op_span_preimage_dnu(sp, nu);
    if (!op_c64_is_finite(w) || !op_c64_is_finite(wnu)) return OP_INVALID_INPUT;
    m = op_c64_abs(w); /* scaled hypot (§23.1) */
    r2 = op_c64_abs2(w);
    if (!(m > 0.0) || !(r2 > 0.0)) return OP_PH_IRREGULAR;
    /* §8.6: w_hat = (a,b); Tx = (a-b)(a+b); Ty = 2ab. */
    a = w.re / m;
    b = w.im / m;
    t = op_c64_make((a - b) * (a + b), 2.0 * a * b);
    if (tangent != NULL) *tangent = t;
    if (normal_left != NULL) *normal_left = op_c64_muli(t); /* N_L = iT */
    if (kappa != NULL) {
        /* kappa = 2 Im(conj(w) w_nu) / (h |w|^4) (§8.6). */
        *kappa = 2.0 * op_c64_cross(w, wnu) / (OP_SPAN_H * r2 * r2);
    }
    return OP_OK;
}

/* ------------------------------------------------------------------ */
/* §8.5: exact forward arc length and compiled reverse polynomial.    */
/* ------------------------------------------------------------------ */
double op_span_arc_forward(const op_span *sp, double nu) {
    return op_decasteljau_d(sp->sA, 5, nu);
}

double op_span_arc_reverse(const op_span *sp, double v) {
    /* S_r(v) = L - S_f(1 - v). */
    return sp->len - op_span_arc_forward(sp, 1.0 - v);
}

/* ------------------------------------------------------------------ */
/* §12.1: degree-3 Bernstein coefficients of A = Im(conj(w) w_nu)     */
/* with d0 = 2(b1-b0), d1 = 2(b2-b1) and the binomial formula.        */
/* ------------------------------------------------------------------ */
void op_span_a_coeffs(const op_span *sp, double a3[4]) {
    op_c64 d[2];
    int k, a;
    if (sp == NULL || a3 == NULL) return;
    d[0] = op_c64_scale(op_c64_sub(sp->b[1], sp->b[0]), 2.0);
    d[1] = op_c64_scale(op_c64_sub(sp->b[2], sp->b[1]), 2.0);
    for (k = 0; k <= 3; k++) {
        double acc = 0.0;
        double denom = op_binomial(3, k);
        for (a = 0; a <= 2; a++) {
            int bidx = k - a;
            double wgt;
            if (bidx < 0 || bidx > 1) continue;
            wgt = op_binomial(2, a) * op_binomial(1, bidx) / denom;
            /* Im(conj(b_a) d_b) = cross(b_a, d_b). */
            acc += wgt * op_c64_cross(sp->b[a], d[bidx]);
        }
        a3[k] = acc;
    }
}
