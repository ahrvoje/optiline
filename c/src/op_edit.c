/* Optiline — atomic strict-local genotype edits (§9.6–§9.9). */
#include <string.h>

#include "optiline/op_complex.h"
#include "optiline/op_construction.h"
#include "optiline/op_span.h"

static op_result op_edit_gates(const op_track *track, const op_genotype *g,
                               op_c64 gates[OP_GATE_COUNT]) {
    int32_t i;
    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 n;
        op_result rc = op_span_frame(&track->center.span[2*i], 0.0, NULL, &n, NULL);
        if (rc != OP_OK) return rc;
        gates[i] = op_c64_add(track->gates[i], op_c64_scale(n, g->d[i]));
    }
    return OP_OK;
}

static op_result op_edit_apply(const op_track *track, op_spline *sp, op_genotype *g,
                               int32_t start, int32_t K, op_qr_workspace *ws) {
    op_spline trial = *sp;
    op_c64 gates[OP_GATE_COUNT];
    int32_t free_idx[12], constraints[7];
    int32_t i, free_count = 2*K-2;
    double residual;
    op_result rc = op_edit_gates(track, g, gates);
    if (rc != OP_OK) return rc;
    for (i = 0; i < K; i++) constraints[i] = start + i;
    for (i = 0; i < free_count; i++) free_idx[i] = 2*start + 1 + i;
    rc = op_construction_project(trial.c, gates, free_idx, free_count,
                                 constraints, K, 1e-12, 40,
                                 1e-10 * track->scale_h, ws);
    if (rc != OP_OK) return rc;
    rc = op_spline_compile(&trial, gates);
    if (rc != OP_OK) return rc;
    rc = op_construction_verify(&trial, gates, 1e-10 * track->scale_h,
                                trial.total_len / OP_PERIOD, &residual);
    if (rc != OP_OK) return rc;
    *sp = trial;
    return OP_OK;
}

op_result op_construction_edit_one(const op_track *track, op_spline *sp,
                                   op_genotype *g, int32_t gate, double new_d,
                                   op_qr_workspace *ws) {
    op_genotype old;
    op_result rc;
    if (track == NULL || sp == NULL || g == NULL || ws == NULL) return OP_INVALID_INPUT;
    old = *g;
    g->d[op_wrap_index(gate, OP_GATE_COUNT)] = new_d;
    rc = op_edit_apply(track, sp, g, gate - 2, 5, ws);
    if (rc != OP_OK) *g = old;
    return rc;
}

op_result op_construction_edit_three(const op_track *track, op_spline *sp,
                                     op_genotype *g, int32_t gate, double delta_d,
                                     op_qr_workspace *ws) {
    op_genotype old;
    static const double weight[3] = {0.25, 0.5, 0.25};
    int i;
    op_result rc;
    if (track == NULL || sp == NULL || g == NULL || ws == NULL) return OP_INVALID_INPUT;
    old = *g;
    for (i = 0; i < 3; i++) {
        int32_t gi = op_wrap_index(gate - 1 + i, OP_GATE_COUNT);
        g->d[gi] += weight[i] * delta_d;
    }
    rc = op_edit_apply(track, sp, g, gate - 3, 7, ws);
    if (rc != OP_OK) *g = old;
    return rc;
}
