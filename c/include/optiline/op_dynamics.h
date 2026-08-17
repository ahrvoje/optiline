/* Optiline — force-limited point-mass dynamics and the periodic speed
 * profile (§11, §12). */
#ifndef OPTILINE_OP_DYNAMICS_H
#define OPTILINE_OP_DYNAMICS_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Derived aero terms (§11.2). */
op_aero op_dynamics_aero(const op_vehicle *veh);

/* Exact stability utilization U(q, a_t, kappa) (§11.3). */
double op_dynamics_utilization(const op_vehicle *veh, const op_aero *aero,
                               double q, double a_t, double kappa);

/* Pure-lateral pointwise squared-speed cap (new specification §9.7). */
double op_dynamics_q_cap(const op_vehicle *veh, const op_aero *aero, double K);

/* Pointwise net tangential bounds at q=v^2 (new specification §9.6). */
double op_dynamics_net_accel(const op_vehicle *veh, const op_aero *aero,
                             double q, double kappa);
double op_dynamics_net_brake(const op_vehicle *veh, const op_aero *aero,
                             double q, double kappa);

/* Conservative remaining longitudinal capacity G+/G- over q in [ql,qh]
 * (§11.5). Returns OP_DYNAMIC_PROFILE_FAILED if the lateral fraction
 * exceeds 1 at qh. */
op_result op_dynamics_capacity(const op_vehicle *veh, const op_aero *aero,
                               double ql, double qh, double K,
                               double *g_plus, double *g_minus);

/* Implicit-midpoint reach maps with safeguarded bisection (§10.3, §10.4). */
double op_dynamics_forward_reach(const op_vehicle *veh, const op_aero *aero,
                                 double q0, double qc, double ds, double K);
double op_dynamics_brake_reach(const op_vehicle *veh, const op_aero *aero,
                               double q1, double qc, double ds, double K);

/* Edge feasibility check (§12.2) for the certified recheck. */
op_result op_dynamics_edge_feasible(const op_vehicle *veh, const op_aero *aero,
                                    double qi, double qj, double ds, double K);

/* Periodic grid input: per-edge exact lengths and certified curvature
 * bounds. Cyclic maximal envelope by Jacobi relaxation (§12.5) with the
 * binary64 tolerance and OP_ENVELOPE_MAX_ITER_C99 cap, then per-edge
 * recheck; exact edge times and Neumaier lap time (§12.7). */
typedef struct op_dyn_grid {
    int32_t edge_count;
    int32_t pad_;
    double  ds[OP_MAX_PROFILE_EDGES];
    double  K[OP_MAX_PROFILE_EDGES];       /* per-edge curvature bound */
    double  kappa_node[OP_MAX_PROFILE_EDGES]; /* signed sample at node */
    double  nu_global[OP_MAX_PROFILE_EDGES];  /* node PH parameter     */
} op_dyn_grid;

op_result op_dynamics_solve_envelope(const op_vehicle *veh, const op_dyn_grid *grid,
                                     double q[OP_MAX_PROFILE_EDGES],
                                     double *fixed_point_residual);

op_result op_dynamics_profile(const op_vehicle *veh, const op_dyn_grid *grid,
                              op_profile *out);

/* Build the dynamic grid from a compiled spline: `edges_per_span` equal
 * parameter subdivisions per PH span (2 for the 256-grid, 8 for the 1024
 * incumbent grid). Exact lengths from forward arc differences (§12.1). */
op_result op_dynamics_build_grid(const op_spline *sp, int32_t edges_per_span,
                                 int refine_bounds, op_dyn_grid *grid);

/* Adaptive incumbent profile (§12.8): refine per-edge until certified or
 * OP_MAX_PROFILE_EDGES; writes final profile + certificate fields. */
op_result op_dynamics_adaptive_profile(const op_track *track, const op_spline *sp,
                                       const op_vehicle *veh, op_profile *out,
                                       op_certificate *cert);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_DYNAMICS_H */
