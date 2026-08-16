/* Optiline — exact PH displacement constraints and nonlinear projection (§9). */
#include <float.h>
#include <math.h>
#include <string.h>

#include "optiline/op_complex.h"
#include "optiline/op_construction.h"
#include "optiline/op_math.h"
#include "optiline/op_regularity.h"
#include "optiline/op_span.h"

op_c64 op_construction_phi(const op_c64 b[3]) { return op_span_displacement(b); }

void op_construction_phi_grad(const op_c64 b[3], op_c64 v[3]) {
    int k, a;
    for (k = 0; k < 3; k++) {
        v[k] = op_c64_make(0.0, 0.0);
        for (a = 0; a < 3; a++)
            v[k] = op_c64_add(v[k], op_c64_scale(b[a], 2.0 * OP_SPAN_H * OP_GRAM[3*k+a]));
    }
}

void op_construction_residuals(const op_c64 c[OP_SPAN_COUNT],
                               const op_c64 gate_points[OP_GATE_COUNT],
                               op_c64 F[OP_GATE_COUNT]) {
    int32_t i;
    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 b0[3], b1[3];
        op_c64 target = op_c64_sub(gate_points[(i + 1) % OP_GATE_COUNT], gate_points[i]);
        op_span_extract_preimage(c, 2*i, b0);
        op_span_extract_preimage(c, 2*i+1, b1);
        F[i] = op_c64_sub(op_c64_add(op_construction_phi(b0), op_construction_phi(b1)), target);
    }
}

static void op_unwrap(int32_t index, int32_t *base, int *sign) {
    int32_t q = index / OP_SPAN_COUNT;
    int32_t r = index % OP_SPAN_COUNT;
    if (r < 0) { r += OP_SPAN_COUNT; q--; }
    *base = r;
    *sign = (q & 1) != 0 ? -1 : 1;
}

static op_c64 op_span_control_derivative(const op_c64 c[OP_SPAN_COUNT],
                                         int32_t span_index, int32_t free_index) {
    op_c64 b[3], v[3], result = {0.0, 0.0};
    int32_t free_base, tbase;
    int free_sign, tsign;
    int term;
    static const double extraction[3][3] = {
        {0.5, 0.5, 0.0}, {0.0, 1.0, 0.0}, {0.0, 0.5, 0.5}
    };
    op_span_extract_preimage(c, span_index, b);
    op_construction_phi_grad(b, v);
    op_unwrap(free_index, &free_base, &free_sign);
    for (term = 0; term < 3; term++) {
        int k;
        int32_t source = span_index - 1 + term;
        op_unwrap(source, &tbase, &tsign);
        if (tbase != free_base) continue;
        for (k = 0; k < 3; k++) {
            double factor = extraction[k][term] * (double)(tsign * free_sign);
            result = op_c64_add(result, op_c64_scale(v[k], factor));
        }
    }
    return result;
}

static double op_selected_residuals(const op_c64 c[OP_SPAN_COUNT],
                                    const op_c64 gates[OP_GATE_COUNT],
                                    const int32_t *constraints, int32_t count,
                                    double *f, double *max_abs) {
    op_c64 all[OP_GATE_COUNT];
    double norm2 = 0.0, maximum = 0.0;
    int32_t k;
    op_construction_residuals(c, gates, all);
    for (k = 0; k < count; k++) {
        int32_t ci = op_wrap_index(constraints[k], OP_GATE_COUNT);
        f[2*k] = all[ci].re;
        f[2*k+1] = all[ci].im;
        norm2 += all[ci].re * all[ci].re + all[ci].im * all[ci].im;
        maximum = fmax(maximum, hypot(all[ci].re, all[ci].im));
    }
    if (max_abs != NULL) *max_abs = maximum;
    return norm2;
}

static int op_controls_immediately_regular(const op_c64 c[OP_SPAN_COUNT],
                                           const int32_t *constraints, int32_t count) {
    int32_t k;
    for (k = 0; k < count; k++) {
        int32_t ci = op_wrap_index(constraints[k], OP_GATE_COUNT);
        int s;
        for (s = 0; s < 2; s++) {
            op_c64 b[3];
            double bound;
            op_span_extract_preimage(c, 2*ci+s, b);
            if (op_regularity_certify_span(b, 1e-18, &bound) != OP_OK) return 0;
        }
    }
    return 1;
}

op_result op_construction_project(op_c64 c[OP_SPAN_COUNT],
                                  const op_c64 gate_points[OP_GATE_COUNT],
                                  const int32_t *free_idx, int32_t free_count,
                                  const int32_t *constraint_idx, int32_t constraint_count,
                                  double rtol, int max_iter, double tol_abs,
                                  op_qr_workspace *ws) {
    op_c64 trial[OP_SPAN_COUNT];
    int32_t n = 2*free_count, m = 2*constraint_count;
    int iter;
    if (c == NULL || gate_points == NULL || free_idx == NULL || constraint_idx == NULL ||
        ws == NULL || free_count <= 0 || constraint_count <= 0 || n < m ||
        n > OP_QR_MAX_N || m > OP_QR_MAX_M) return OP_INVALID_INPUT;
    for (iter = 0; iter < max_iter; iter++) {
        double current_max, current_norm;
        int32_t k, fidx;
        current_norm = op_selected_residuals(c, gate_points, constraint_idx,
                                             constraint_count, ws->f, &current_max);
        if (current_max <= tol_abs) return OP_OK;
        memset(ws->a, 0, (size_t)n * (size_t)m * sizeof(double));
        for (k = 0; k < constraint_count; k++) {
            int32_t ci = op_wrap_index(constraint_idx[k], OP_GATE_COUNT);
            for (fidx = 0; fidx < free_count; fidx++) {
                op_c64 d = op_c64_add(
                    op_span_control_derivative(c, 2*ci, free_idx[fidx]),
                    op_span_control_derivative(c, 2*ci+1, free_idx[fidx]));
                ws->a[2*fidx + n*(2*k)] = d.re;
                ws->a[2*fidx+1 + n*(2*k)] = -d.im;
                ws->a[2*fidx + n*(2*k+1)] = d.im;
                ws->a[2*fidx+1 + n*(2*k+1)] = d.re;
            }
        }
        {
            op_result rc = op_qr_min_norm_step(ws->a, n, m, ws->f, rtol,
                                                ws->delta, ws);
            if (rc != OP_OK) return rc;
        }
        {
            double alpha = 1.0;
            int accepted = 0, ls;
            for (ls = 0; ls < 8; ls++, alpha *= 0.5) {
                double trial_norm, trial_max;
                memcpy(trial, c, sizeof trial);
                for (fidx = 0; fidx < free_count; fidx++) {
                    int32_t base;
                    int sign;
                    op_unwrap(free_idx[fidx], &base, &sign);
                    trial[base].re += (double)sign * alpha * ws->delta[2*fidx];
                    trial[base].im += (double)sign * alpha * ws->delta[2*fidx+1];
                }
                trial_norm = op_selected_residuals(trial, gate_points, constraint_idx,
                                                   constraint_count, ws->f_trial,
                                                   &trial_max);
                if (op_is_finite(trial_norm) && trial_norm < current_norm &&
                    op_controls_immediately_regular(trial, constraint_idx, constraint_count)) {
                    memcpy(c, trial, sizeof trial);
                    accepted = 1;
                    break;
                }
            }
            if (!accepted) return OP_PH_PROJECTION_FAILED;
        }
    }
    return OP_PH_PROJECTION_FAILED;
}

static op_result op_racing_gates(const op_track *track, const op_genotype *g,
                                 op_c64 gates[OP_GATE_COUNT]) {
    int32_t i;
    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 normal;
        op_result rc = op_span_frame(&track->center.span[2*i], 0.0, NULL, &normal, NULL);
        if (rc != OP_OK) return rc;
        gates[i] = op_c64_add(track->gates[i], op_c64_scale(normal, g->d[i]));
    }
    return OP_OK;
}

op_result op_construction_build(const op_track *track, const op_genotype *g,
                                const op_spline *warm, op_spline *out,
                                op_qr_workspace *ws, double *max_residual) {
    op_c64 gates[OP_GATE_COUNT];
    int32_t free_idx[OP_SPAN_COUNT], constraints[OP_GATE_COUNT];
    int32_t i;
    op_result rc;
    if (track == NULL || g == NULL || out == NULL || ws == NULL) return OP_INVALID_INPUT;
    rc = op_racing_gates(track, g, gates);
    if (rc != OP_OK) return rc;
    if (warm != NULL) memcpy(out->c, warm->c, sizeof out->c);
    else {
        rc = op_construction_seed(gates, out->c);
        if (rc != OP_OK) return rc;
    }
    for (i = 0; i < OP_SPAN_COUNT; i++) free_idx[i] = i;
    for (i = 0; i < OP_GATE_COUNT; i++) constraints[i] = i;
    rc = op_construction_project(out->c, gates, free_idx, OP_SPAN_COUNT,
                                 constraints, OP_GATE_COUNT, 1e-12, 40,
                                 1e-10 * track->scale_h, ws);
    if (rc != OP_OK) return rc;
    rc = op_spline_compile(out, gates);
    if (rc != OP_OK) return rc;
    return op_construction_verify(out, gates, 1e-10 * track->scale_h,
                                  out->total_len / OP_PERIOD, max_residual);
}

op_result op_construction_verify(const op_spline *sp,
                                 const op_c64 gate_points[OP_GATE_COUNT],
                                 double tol_interp, double sigma_ref,
                                 double *max_residual) {
    op_c64 f[OP_GATE_COUNT], t0, t1;
    double maximum = 0.0, min_w2, k0, k1;
    int32_t i;
    op_result rc;
    if (sp == NULL || gate_points == NULL || !(sp->total_len > 0.0))
        return OP_PH_INTERPOLATION_RESIDUAL;
    op_construction_residuals(sp->c, gate_points, f);
    for (i = 0; i < OP_GATE_COUNT; i++) maximum = fmax(maximum, hypot(f[i].re, f[i].im));
    if (max_residual != NULL) *max_residual = maximum;
    if (maximum > tol_interp) return OP_PH_INTERPOLATION_RESIDUAL;
    rc = op_regularity_certify_spline(sp, sigma_ref, &min_w2);
    if (rc != OP_OK) return rc;
    rc = op_span_frame(&sp->span[0], 0.0, &t0, NULL, &k0);
    if (rc != OP_OK) return rc;
    rc = op_span_frame(&sp->span[OP_SPAN_COUNT-1], 1.0, &t1, NULL, &k1);
    if (rc != OP_OK) return rc;
    if (hypot(t0.re-t1.re, t0.im-t1.im) > 1e-9 || fabs(k0-k1) > 1e-8)
        return OP_PH_INTERPOLATION_RESIDUAL;
    return OP_OK;
}

double op_spline_signed_area(const op_spline *sp) {
    op_neumaier sum;
    int32_t j;
    op_neumaier_init(&sum);
    if (sp == NULL) return 0.0;
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        int a, b;
        double cross_sum = 0.0;
        for (a = 0; a <= 5; a++) {
            for (b = 0; b <= 4; b++) {
                double weight = op_binomial(5,a) * op_binomial(4,b) /
                                (10.0 * op_binomial(9,a+b));
                cross_sum += weight * op_c64_cross(sp->span[j].p[a],
                    op_c64_scale(sp->span[j].q[b], OP_SPAN_H));
            }
        }
        op_neumaier_add(&sum, 0.5 * cross_sum);
    }
    return op_neumaier_value(&sum);
}
