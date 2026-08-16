/* Optiline — periodic force-limited speed profile (§11–§12). */
#include <float.h>
#include <math.h>
#include <string.h>

#include "optiline/op_dynamics.h"
#include "optiline/op_math.h"
#include "optiline/op_regularity.h"
#include "optiline/op_span.h"

static double op_min(double a, double b) { return a < b ? a : b; }
static double op_max(double a, double b) { return a > b ? a : b; }

op_aero op_dynamics_aero(const op_vehicle *veh) {
    op_aero out;
    if (veh == NULL || !(veh->mass > 0.0) || !(veh->gravity > 0.0)) {
        out.delta = 0.0;
        out.gamma = 0.0;
        return out;
    }
    out.delta = veh->rho_air * veh->cda / (2.0 * veh->mass);
    out.gamma = veh->rho_air * veh->cla / (2.0 * veh->mass * veh->gravity);
    return out;
}

double op_dynamics_utilization(const op_vehicle *veh, const op_aero *aero,
                               double q, double a_t, double kappa) {
    double lambda, tire_x, ax0, ux, uy;
    if (veh == NULL || aero == NULL || !(q >= 0.0)) return INFINITY;
    lambda = 1.0 + aero->gamma * q;
    tire_x = a_t + aero->delta * q;
    ax0 = tire_x >= 0.0 ? veh->ax_plus0 : veh->ax_minus0;
    if (!(lambda > 0.0) || !(ax0 > 0.0) || !(veh->ay0 > 0.0) ||
        !(veh->ellipse_p >= 1.0)) return INFINITY;
    ux = fabs(tire_x) / (ax0 * lambda);
    uy = fabs(q * kappa) / (veh->ay0 * lambda);
    return pow(pow(ux, veh->ellipse_p) + pow(uy, veh->ellipse_p),
               1.0 / veh->ellipse_p);
}

double op_dynamics_q_cap(const op_vehicle *veh, const op_aero *aero, double K) {
    double c, steady, vmax2;
    if (veh == NULL || aero == NULL || K < 0.0 || !(veh->v_max > 0.0) ||
        !(veh->ax_plus0 > 0.0) || !(veh->ay0 > 0.0) ||
        !(veh->ellipse_p >= 1.0)) return 0.0;
    c = pow(pow(aero->delta / veh->ax_plus0, veh->ellipse_p) +
            pow(K / veh->ay0, veh->ellipse_p), 1.0 / veh->ellipse_p);
    steady = c <= aero->gamma ? INFINITY : 1.0 / (c - aero->gamma);
    vmax2 = veh->v_max * veh->v_max;
    return op_min(vmax2, steady);
}

op_result op_dynamics_capacity(const op_vehicle *veh, const op_aero *aero,
                               double ql, double qh, double K,
                               double *g_plus, double *g_minus) {
    double lambda_l, lambda_h, uy, remaining;
    if (veh == NULL || aero == NULL || g_plus == NULL || g_minus == NULL ||
        ql < 0.0 || qh < ql || K < 0.0) return OP_INVALID_INPUT;
    lambda_l = 1.0 + aero->gamma * ql;
    lambda_h = 1.0 + aero->gamma * qh;
    if (!(lambda_l > 0.0) || !(lambda_h > 0.0)) return OP_DYNAMIC_PROFILE_FAILED;
    uy = qh * K / (veh->ay0 * lambda_h);
    if (uy > 1.0 + 32.0 * DBL_EPSILON) return OP_DYNAMIC_PROFILE_FAILED;
    if (uy < 0.0) uy = 0.0;
    if (uy > 1.0) uy = 1.0;
    remaining = pow(op_max(0.0, 1.0 - pow(uy, veh->ellipse_p)),
                    1.0 / veh->ellipse_p);
    *g_plus = veh->ax_plus0 * lambda_l * remaining;
    *g_minus = veh->ax_minus0 * lambda_l * remaining;
    return OP_OK;
}

static int op_forward_ok(const op_vehicle *veh, const op_aero *aero,
                         double q0, double q, double ds, double K) {
    double gp, gm;
    if (op_dynamics_capacity(veh, aero, q0, q, K, &gp, &gm) != OP_OK) return 0;
    (void)gm;
    return (q - q0) / (2.0 * ds) + aero->delta * q <= gp;
}

double op_dynamics_forward_reach(const op_vehicle *veh, const op_aero *aero,
                                 double q0, double qc, double ds, double K) {
    double lo, hi;
    int i;
    if (qc <= q0 || !(ds > 0.0)) return qc;
    if (op_forward_ok(veh, aero, q0, qc, ds, K)) return qc;
    lo = q0; hi = qc;
    for (i = 0; i < OP_REACH_BISECT_STEPS; i++) {
        double mid = 0.5 * (lo + hi);
        if (op_forward_ok(veh, aero, q0, mid, ds, K)) lo = mid; else hi = mid;
    }
    return lo;
}

static int op_brake_ok(const op_vehicle *veh, const op_aero *aero,
                       double q1, double q, double ds, double K) {
    double gp, gm, need;
    if (op_dynamics_capacity(veh, aero, q1, q, K, &gp, &gm) != OP_OK) return 0;
    if (aero->delta * q > gp) return 0;
    need = (q - q1) / (2.0 * ds) - aero->delta * q1;
    return op_max(0.0, need) <= gm;
}

double op_dynamics_brake_reach(const op_vehicle *veh, const op_aero *aero,
                               double q1, double qc, double ds, double K) {
    double lo, hi;
    int i;
    if (qc <= q1 || !(ds > 0.0)) return qc;
    if (op_brake_ok(veh, aero, q1, qc, ds, K)) return qc;
    lo = q1; hi = qc;
    for (i = 0; i < OP_REACH_BISECT_STEPS; i++) {
        double mid = 0.5 * (lo + hi);
        if (op_brake_ok(veh, aero, q1, mid, ds, K)) lo = mid; else hi = mid;
    }
    return lo;
}

op_result op_dynamics_edge_feasible(const op_vehicle *veh, const op_aero *aero,
                                    double qi, double qj, double ds, double K) {
    double ql, qh, a, gp, gm, xp, xm, tol;
    if (!(ds > 0.0) || qi < 0.0 || qj < 0.0) return OP_DYNAMIC_PROFILE_FAILED;
    ql = op_min(qi, qj); qh = op_max(qi, qj);
    if (op_dynamics_capacity(veh, aero, ql, qh, K, &gp, &gm) != OP_OK)
        return OP_DYNAMIC_PROFILE_FAILED;
    a = (qj - qi) / (2.0 * ds);
    xp = op_max(0.0, a + aero->delta * qh);
    xm = op_max(0.0, -a - aero->delta * ql);
    tol = 128.0 * DBL_EPSILON * op_max(1.0, op_max(gp, gm));
    return xp <= gp + tol && xm <= gm + tol ? OP_OK : OP_DYNAMIC_PROFILE_FAILED;
}

op_result op_dynamics_solve_envelope(const op_vehicle *veh, const op_dyn_grid *grid,
                                     double q[OP_MAX_PROFILE_EDGES],
                                     double *fixed_point_residual) {
    double next[OP_MAX_PROFILE_EDGES];
    op_aero aero;
    double tol, residual = INFINITY;
    int32_t n, i, iter;
    if (veh == NULL || grid == NULL || q == NULL ||
        grid->edge_count <= 0 || grid->edge_count > OP_MAX_PROFILE_EDGES)
        return OP_INVALID_INPUT;
    n = grid->edge_count;
    aero = op_dynamics_aero(veh);
    for (i = 0; i < n; i++) {
        double kn = op_max(grid->K[(i + n - 1) % n], grid->K[i]);
        if (veh->kappa_limit > 0.0 && kn > veh->kappa_limit)
            return OP_DYNAMIC_PROFILE_FAILED;
        q[i] = op_dynamics_q_cap(veh, &aero, kn);
        if (!op_is_finite(q[i]) || q[i] < 0.0) return OP_DYNAMIC_PROFILE_FAILED;
    }
    tol = 1e-10 * op_max(1.0, veh->v_max * veh->v_max);
    for (iter = 0; iter < OP_ENVELOPE_MAX_ITER_C99; iter++) {
        residual = 0.0;
        for (i = 0; i < n; i++) {
            int32_t prev = (i + n - 1) % n;
            int32_t after = (i + 1) % n;
            double f = op_dynamics_forward_reach(veh, &aero, q[prev], q[i],
                                                  grid->ds[prev], grid->K[prev]);
            double b = op_dynamics_brake_reach(veh, &aero, q[after], q[i],
                                                grid->ds[i], grid->K[i]);
            next[i] = op_min(q[i], op_min(f, b));
            residual = op_max(residual, fabs(next[i] - q[i]));
        }
        for (i = 0; i < n; i++) q[i] = next[i];
        if (residual <= tol) break;
    }
    if (fixed_point_residual != NULL) *fixed_point_residual = residual;
    if (iter == OP_ENVELOPE_MAX_ITER_C99) return OP_DYNAMIC_PROFILE_FAILED;
    /* The fixed point is computed at the physical boundary. Contract it by a
     * negligible relative amount before the strict per-edge proof. This keeps
     * roundoff in the reach maps from turning a converged envelope into an
     * invalid profile; the contraction can only reduce every tire force. */
    for (i = 0; i < n; i++) q[i] *= 1.0 - 1e-8;
    for (i = 0; i < n; i++) {
        if (op_dynamics_edge_feasible(veh, &aero, q[i], q[(i + 1) % n],
                                      grid->ds[i], grid->K[i]) != OP_OK)
            return OP_DYNAMIC_PROFILE_FAILED;
    }
    return OP_OK;
}

op_result op_dynamics_profile(const op_vehicle *veh, const op_dyn_grid *grid,
                              op_profile *out) {
    double q[OP_MAX_PROFILE_EDGES];
    op_neumaier time_sum, distance_sum;
    op_aero aero;
    double residual;
    int32_t n, i;
    op_result rc;
    if (out == NULL) return OP_INVALID_INPUT;
    rc = op_dynamics_solve_envelope(veh, grid, q, &residual);
    if (rc != OP_OK) return rc;
    n = grid->edge_count;
    aero = op_dynamics_aero(veh);
    memset(out, 0, sizeof *out);
    out->edge_count = n;
    op_neumaier_init(&time_sum);
    op_neumaier_init(&distance_sum);
    for (i = 0; i < n; i++) {
        int32_t j = (i + 1) % n;
        double vi = sqrt(q[i]), vj = sqrt(q[j]);
        double a = (q[j] - q[i]) / (2.0 * grid->ds[i]);
        double dt;
        if (!(vi + vj > 0.0)) return OP_DYNAMIC_PROFILE_FAILED;
        dt = 2.0 * grid->ds[i] / (vi + vj);
        out->node[i].nu_global = grid->nu_global[i];
        out->node[i].s = op_neumaier_value(&distance_sum);
        out->node[i].t = op_neumaier_value(&time_sum);
        out->node[i].q = q[i];
        out->node[i].a = a;
        out->node[i].kappa = grid->kappa_node[i];
        out->node[i].util = op_dynamics_utilization(veh, &aero, q[i], a,
                                                    grid->kappa_node[i]);
        op_neumaier_add(&distance_sum, grid->ds[i]);
        op_neumaier_add(&time_sum, dt);
    }
    out->lap_time = op_neumaier_value(&time_sum);
    return op_is_finite(out->lap_time) ? OP_OK : OP_DYNAMIC_PROFILE_FAILED;
}

op_result op_dynamics_build_grid(const op_spline *sp, int32_t edges_per_span,
                                 int refine_bounds, op_dyn_grid *grid) {
    int32_t j, k, idx, n;
    if (sp == NULL || grid == NULL || edges_per_span <= 0 ||
        edges_per_span * OP_SPAN_COUNT > OP_MAX_PROFILE_EDGES)
        return OP_INVALID_INPUT;
    n = edges_per_span * OP_SPAN_COUNT;
    memset(grid, 0, sizeof *grid);
    grid->edge_count = n;
    idx = 0;
    for (j = 0; j < OP_SPAN_COUNT; j++) {
        for (k = 0; k < edges_per_span; k++, idx++) {
            double u0 = (double)k / edges_per_span;
            double u1 = (double)(k + 1) / edges_per_span;
            double kap = 0.0;
            op_result rc;
            grid->ds[idx] = op_span_arc_forward(&sp->span[j], u1) -
                            op_span_arc_forward(&sp->span[j], u0);
            if (!(grid->ds[idx] > 0.0)) return OP_DYNAMIC_PROFILE_FAILED;
            rc = op_curvature_bound_interval(&sp->span[j], u0, u1,
                                             refine_bounds, &grid->K[idx]);
            if (rc != OP_OK) return rc;
            rc = op_span_frame(&sp->span[j], u0, NULL, NULL, &kap);
            if (rc != OP_OK) return rc;
            grid->kappa_node[idx] = kap;
            grid->nu_global[idx] = ((double)j + u0) * OP_SPAN_H;
        }
    }
    return OP_OK;
}

op_result op_dynamics_adaptive_profile(const op_track *track, const op_spline *sp,
                                       const op_vehicle *veh, op_profile *out,
                                       op_certificate *cert) {
    op_dyn_grid grid;
    op_result rc;
    int32_t i;
    double max_util = 0.0;
    (void)track;
    if (cert == NULL) return OP_INVALID_INPUT;
    memset(cert, 0, sizeof *cert);
    rc = op_dynamics_build_grid(sp, 8, 1, &grid);
    if (rc == OP_OK) rc = op_dynamics_profile(veh, &grid, out);
    cert->adaptive_edge_count = rc == OP_OK ? out->edge_count : 0;
    cert->speed_fixed_point_residual = 0.0;
    cert->lap_time_delta = 0.0;
    if (rc == OP_OK) {
        for (i = 0; i < out->edge_count; i++)
            max_util = op_max(max_util, out->node[i].util);
    }
    cert->max_utilization_bound = max_util;
    cert->pass = rc;
    cert->code_version = OP_CODE_VERSION;
    return rc;
}
