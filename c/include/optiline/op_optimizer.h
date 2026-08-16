/* Optiline — deterministic RNG and CPU fallback replica-exchange search
 * (§13, §22). The CPU path keeps every formula and certificate rule. */
#ifndef OPTILINE_OP_OPTIMIZER_H
#define OPTILINE_OP_OPTIMIZER_H

#include "optiline/op_types.h"
#include "optiline/op_construction.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Philox4x32-10 (§13.6). counter = (batch_low, batch_high, chain_id,
 * draw_block); key = user seed as two u32 words. */
typedef struct op_philox_ctr { uint32_t v[4]; } op_philox_ctr;
typedef struct op_philox_key { uint32_t v[2]; } op_philox_key;
void op_philox4x32_10(op_philox_ctr ctr, op_philox_key key, uint32_t out[4]);

/* Open-interval uniform: U = (x + 0.5) * 2^-32 (§13.6). */
double op_philox_uniform(uint32_t x);

/* Irwin–Hall approximate normal: sum of 12 uniforms minus 6 (§13.2).
 * Consumes exactly three Philox blocks (12 words) starting at
 * draw_block; increments *draw_block. */
double op_philox_normal(uint32_t batch_lo, uint32_t batch_hi, uint32_t chain_id,
                        uint32_t *draw_block, op_philox_key key);

/* Reflection into [a,b] (§13.2); nonnegative real modulo, no clamping. */
double op_reflect(double x, double a, double b);

/* Temperature ladder tau_l = 10^(-6 + 6 l / 31) (§13.1). */
double op_optimizer_tau(int level);

#define OP_CHAIN_LEVELS   32
#define OP_CHAIN_REPLICAS 32
#define OP_CHAIN_COUNT    (OP_CHAIN_LEVELS * OP_CHAIN_REPLICAS)

typedef struct op_chain {
    op_genotype g;
    op_spline   line;
    double      lap_time;
    double      energy;
    double      sigma;       /* current step size of its level        */
    int32_t     level;
    int32_t     chain_id;
    int32_t     accepted;
    int32_t     stagnation;
    int32_t     valid;
    int32_t     pad_;
} op_chain;

/* One CPU search step for one chain: propose (7/8 one-gate, 1/8
 * three-gate), strict-local rebuild, full certification chain, dynamic
 * profile on the 256 grid, Metropolis accept (§13.1–§13.2, §22).
 * reject_out receives the §14.5 first-failure code. */
op_result op_cpu_search_step(const op_track *track, const op_vehicle *veh,
                             op_chain *chain, uint32_t batch_lo, uint32_t batch_hi,
                             op_philox_key key, op_qr_workspace *ws,
                             op_reject_code *reject_out,
                             double t0_seed_lap_time);

/* Full candidate evaluation used by both CPU search and incumbent
 * certification: construction + regularity + simplicity + containment +
 * envelope + lap time on the given grid density. */
op_result op_candidate_evaluate(const op_track *track, const op_vehicle *veh,
                                const op_genotype *g, const op_spline *warm,
                                int32_t edges_per_span, op_spline *line_out,
                                double *lap_time_out, op_qr_workspace *ws,
                                op_reject_code *reject_out);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_OPTIMIZER_H */
