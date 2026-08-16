/* Optiline — deterministic principal-root seed and sign dynamic program (§9.4). */
#include <float.h>
#include <math.h>

#include "optiline/op_complex.h"
#include "optiline/op_construction.h"
#include "optiline/op_math.h"

static op_c64 op_principal_sqrt(op_c64 z) {
    double m = hypot(z.re, z.im);
    double u = sqrt(fmax(0.0, 0.5 * (m + z.re)));
    double q;
    if (u == 0.0) q = copysign(sqrt(m), z.im);
    else q = copysign(sqrt(fmax(0.0, 0.5 * (m - z.re))), z.im);
    return op_c64_make(u, q);
}

static double op_sign_distance(op_c64 a, int sa, op_c64 b, int sb) {
    op_c64 d = op_c64_sub(op_c64_scale(a, (double)sa), op_c64_scale(b, (double)sb));
    return op_c64_abs2(d);
}

op_result op_construction_seed(const op_c64 gate_points[OP_GATE_COUNT],
                               op_c64 c[OP_SPAN_COUNT]) {
    op_c64 d[OP_GATE_COUNT], root[OP_GATE_COUNT], signed_root[OP_GATE_COUNT];
    double best_total = INFINITY;
    int best_sign[OP_GATE_COUNT];
    int32_t i;
    int s0_index;
    if (gate_points == NULL || c == NULL) return OP_INVALID_INPUT;
    for (i = 0; i < OP_GATE_COUNT; i++) {
        d[i] = op_c64_sub(gate_points[(i + 1) % OP_GATE_COUNT], gate_points[i]);
        if (!op_c64_is_finite(d[i])) return OP_INVALID_INPUT;
    }
    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 dm = d[(i + OP_GATE_COUNT - 1) % OP_GATE_COUNT];
        op_c64 guide = op_c64_scale(op_c64_add(dm, d[i]), 0.5);
        double threshold = 32.0 * DBL_EPSILON * fmax(op_c64_abs(dm), op_c64_abs(d[i]));
        if (op_c64_abs(guide) <= threshold) {
            guide = op_c64_abs(dm) >= op_c64_abs(d[i]) ? dm : d[i];
        }
        root[i] = op_principal_sqrt(op_c64_scale(guide, 1.0 / OP_SPAN_H));
    }
    for (s0_index = 0; s0_index < 2; s0_index++) {
        double cost[OP_GATE_COUNT][2];
        int prev[OP_GATE_COUNT][2];
        int s0 = s0_index == 0 ? 1 : -1;
        int state;
        cost[0][0] = s0 == 1 ? 0.0 : INFINITY;
        cost[0][1] = s0 == -1 ? 0.0 : INFINITY;
        prev[0][0] = prev[0][1] = -1;
        for (i = 1; i < OP_GATE_COUNT; i++) {
            int cur;
            for (cur = 0; cur < 2; cur++) {
                int scur = cur == 0 ? 1 : -1;
                double cplus = cost[i - 1][0] + op_sign_distance(root[i], scur, root[i - 1], 1);
                double cminus = cost[i - 1][1] + op_sign_distance(root[i], scur, root[i - 1], -1);
                if (cplus <= cminus) { cost[i][cur] = cplus; prev[i][cur] = 0; }
                else { cost[i][cur] = cminus; prev[i][cur] = 1; }
            }
        }
        for (state = 0; state < 2; state++) {
            int slast = state == 0 ? 1 : -1;
            double total = cost[OP_GATE_COUNT - 1][state] +
                op_c64_abs2(op_c64_add(op_c64_scale(root[OP_GATE_COUNT - 1], (double)slast),
                                       op_c64_scale(root[0], (double)s0)));
            if (total < best_total || (total == best_total && s0 == 1)) {
                int cur = state;
                best_total = total;
                for (i = OP_GATE_COUNT - 1; i >= 0; i--) {
                    best_sign[i] = cur == 0 ? 1 : -1;
                    cur = prev[i][cur];
                }
            }
        }
    }
    for (i = 0; i < OP_GATE_COUNT; i++)
        signed_root[i] = op_c64_scale(root[i], (double)best_sign[i]);
    for (i = 0; i < OP_GATE_COUNT; i++) {
        op_c64 next = i + 1 < OP_GATE_COUNT ? signed_root[i + 1]
                                             : op_c64_neg(signed_root[0]);
        c[2 * i] = signed_root[i];
        c[2 * i + 1] = op_c64_scale(op_c64_add(signed_root[i], next), 0.5);
    }
    return OP_OK;
}
