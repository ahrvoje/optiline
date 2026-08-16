/* Optiline — deterministic pivoted Householder minimum-norm solve (§9.5). */
#include <math.h>
#include <string.h>

#include "optiline/op_construction.h"
#include "optiline/op_math.h"

static void op_swap_columns(double *a, int32_t n, int32_t p, int32_t q) {
    int32_t i;
    if (p == q) return;
    for (i = 0; i < n; i++) {
        double t = a[i + n * p];
        a[i + n * p] = a[i + n * q];
        a[i + n * q] = t;
    }
}

op_result op_qr_min_norm_step(double *a, int32_t n, int32_t m,
                              const double *f, double rtol,
                              double *delta, op_qr_workspace *ws) {
    double r00 = 0.0;
    int32_t i, j, k;
    if (a == NULL || f == NULL || delta == NULL || ws == NULL ||
        n < m || n <= 0 || n > OP_QR_MAX_N || m <= 0 || m > OP_QR_MAX_M ||
        !(rtol > 0.0)) return OP_INVALID_INPUT;
    for (j = 0; j < m; j++) {
        ws->perm[j] = j;
        ws->colnorm[j] = 0.0;
        for (i = 0; i < n; i++) ws->colnorm[j] += a[i + n * j] * a[i + n * j];
    }
    for (k = 0; k < m; k++) {
        int32_t pivot = k;
        double best = -1.0;
        for (j = k; j < m; j++) {
            double norm2 = 0.0;
            for (i = k; i < n; i++) norm2 += a[i + n * j] * a[i + n * j];
            if (norm2 > best || (norm2 == best && ws->perm[j] < ws->perm[pivot])) {
                best = norm2;
                pivot = j;
            }
        }
        if (pivot != k) {
            int32_t tp = ws->perm[k];
            op_swap_columns(a, n, k, pivot);
            ws->perm[k] = ws->perm[pivot];
            ws->perm[pivot] = tp;
        }
        {
            double norm = 0.0, alpha, v0, tau;
            for (i = k; i < n; i++) norm = hypot(norm, a[i + n * k]);
            if (!(norm > 0.0) || !op_is_finite(norm)) return OP_PH_RANK_DEFICIENT;
            alpha = -copysign(norm, a[k + n * k]);
            v0 = a[k + n * k] - alpha;
            if (!(fabs(v0) > 0.0)) return OP_PH_RANK_DEFICIENT;
            tau = (alpha - a[k + n * k]) / alpha;
            a[k + n * k] = alpha;
            for (i = k + 1; i < n; i++) a[i + n * k] /= v0;
            ws->tau[k] = tau;
            if (k == 0) r00 = fabs(alpha);
            if (fabs(alpha) <= rtol * r00) return OP_PH_RANK_DEFICIENT;
            for (j = k + 1; j < m; j++) {
                double dot = a[k + n * j];
                for (i = k + 1; i < n; i++) dot += a[i + n * k] * a[i + n * j];
                dot *= tau;
                a[k + n * j] -= dot;
                for (i = k + 1; i < n; i++)
                    a[i + n * j] -= a[i + n * k] * dot;
            }
        }
    }
    for (i = 0; i < m; i++) {
        double rhs = -f[ws->perm[i]];
        for (j = 0; j < i; j++) rhs -= a[j + n * i] * ws->y[j];
        ws->y[i] = rhs / a[i + n * i];
    }
    for (i = 0; i < n; i++) delta[i] = i < m ? ws->y[i] : 0.0;
    for (k = m - 1; k >= 0; k--) {
        double dot = delta[k];
        for (i = k + 1; i < n; i++) dot += a[i + n * k] * delta[i];
        dot *= ws->tau[k];
        delta[k] -= dot;
        for (i = k + 1; i < n; i++) delta[i] -= a[i + n * k] * dot;
    }
    return OP_OK;
}
