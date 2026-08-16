/* Optiline — Bernstein/de Casteljau primitives, compensated sums, and
 * ULP utilities (PROJECT_SPECIFICATION.md §8.5, §10.6, §23.1).
 *
 * ISO C99 subset: no VLAs, no <complex.h>, no allocation, memcpy for bit
 * reinterpretation. Compiles under MSVC /TC /std:c17 /fp:strict /W4 /WX
 * and WASI Clang -std=c99 -Wall -Wextra -Werror -pedantic-errors.
 */
#include <math.h>
#include <string.h>

#include "optiline/op_math.h"

/* Fixed compile-time maximum Bernstein degree handled by these helpers.
 * The project uses degrees 1..9; 16 matches the binomial table bound.   */
#define OP_MATH_MAX_DEGREE 16

static double op_quiet_nan(void) {
    uint64_t bits = 0x7FF8000000000000ull;
    double x;
    memcpy(&x, &bits, sizeof x);
    return x;
}

static int op_degree_ok(int degree) {
    return degree >= 0 && degree <= OP_MATH_MAX_DEGREE;
}

/* ------------------------------------------------------------------ */
/* de Casteljau evaluation (§8.5, §23.1): the authoritative scheme.   */
/* ------------------------------------------------------------------ */
double op_decasteljau_d(const double *coef, int degree, double nu) {
    double tmp[OP_MATH_MAX_DEGREE + 1];
    double s;
    int r, i;
    if (coef == NULL || !op_degree_ok(degree)) return op_quiet_nan();
    s = 1.0 - nu;
    for (i = 0; i <= degree; i++) tmp[i] = coef[i];
    for (r = 1; r <= degree; r++) {
        for (i = 0; i <= degree - r; i++) {
            tmp[i] = s * tmp[i] + nu * tmp[i + 1];
        }
    }
    return tmp[0];
}

op_c64 op_decasteljau_c(const op_c64 *coef, int degree, double nu) {
    op_c64 tmp[OP_MATH_MAX_DEGREE + 1];
    double s;
    int r, i;
    op_c64 bad;
    if (coef == NULL || !op_degree_ok(degree)) {
        bad.re = op_quiet_nan();
        bad.im = bad.re;
        return bad;
    }
    s = 1.0 - nu;
    for (i = 0; i <= degree; i++) tmp[i] = coef[i];
    for (r = 1; r <= degree; r++) {
        for (i = 0; i <= degree - r; i++) {
            tmp[i].re = s * tmp[i].re + nu * tmp[i + 1].re;
            tmp[i].im = s * tmp[i].im + nu * tmp[i + 1].im;
        }
    }
    return tmp[0];
}

/* ------------------------------------------------------------------ */
/* de Casteljau subdivision at nu: left/right coefficient sets.       */
/* left[r] = b_0^{(r)}, right[degree-r] = b_{degree-r}^{(r)}.         */
/* ------------------------------------------------------------------ */
void op_decasteljau_split_d(const double *coef, int degree, double nu,
                            double *left, double *right) {
    double tmp[OP_MATH_MAX_DEGREE + 1];
    double s;
    int r, i;
    if (coef == NULL || left == NULL || right == NULL || !op_degree_ok(degree)) return;
    s = 1.0 - nu;
    for (i = 0; i <= degree; i++) tmp[i] = coef[i];
    left[0] = tmp[0];
    right[degree] = tmp[degree];
    for (r = 1; r <= degree; r++) {
        for (i = 0; i <= degree - r; i++) {
            tmp[i] = s * tmp[i] + nu * tmp[i + 1];
        }
        left[r] = tmp[0];
        right[degree - r] = tmp[degree - r];
    }
}

void op_decasteljau_split_c(const op_c64 *coef, int degree, double nu,
                            op_c64 *left, op_c64 *right) {
    op_c64 tmp[OP_MATH_MAX_DEGREE + 1];
    double s;
    int r, i;
    if (coef == NULL || left == NULL || right == NULL || !op_degree_ok(degree)) return;
    s = 1.0 - nu;
    for (i = 0; i <= degree; i++) tmp[i] = coef[i];
    left[0] = tmp[0];
    right[degree] = tmp[degree];
    for (r = 1; r <= degree; r++) {
        for (i = 0; i <= degree - r; i++) {
            tmp[i].re = s * tmp[i].re + nu * tmp[i + 1].re;
            tmp[i].im = s * tmp[i].im + nu * tmp[i + 1].im;
        }
        left[r] = tmp[0];
        right[degree - r] = tmp[degree - r];
    }
}

/* ------------------------------------------------------------------ */
/* Degree elevation by one step: out has degree+2 entries.            */
/* out_i = (i/(n+1)) c_{i-1} + (1 - i/(n+1)) c_i.                     */
/* ------------------------------------------------------------------ */
void op_bernstein_elevate_d(const double *coef, int degree, double *out) {
    int i;
    double n1;
    if (coef == NULL || out == NULL ||
        degree < 0 || degree > OP_MATH_MAX_DEGREE - 1) return;
    n1 = (double)(degree + 1);
    out[0] = coef[0];
    out[degree + 1] = coef[degree];
    for (i = 1; i <= degree; i++) {
        double a = (double)i / n1;
        out[i] = a * coef[i - 1] + (1.0 - a) * coef[i];
    }
}

void op_bernstein_elevate_c(const op_c64 *coef, int degree, op_c64 *out) {
    int i;
    double n1;
    if (coef == NULL || out == NULL ||
        degree < 0 || degree > OP_MATH_MAX_DEGREE - 1) return;
    n1 = (double)(degree + 1);
    out[0] = coef[0];
    out[degree + 1] = coef[degree];
    for (i = 1; i <= degree; i++) {
        double a = (double)i / n1;
        out[i].re = a * coef[i - 1].re + (1.0 - a) * coef[i].re;
        out[i].im = a * coef[i - 1].im + (1.0 - a) * coef[i].im;
    }
}

/* ------------------------------------------------------------------ */
/* Bernstein derivative coefficients: out_i = n (c_{i+1} - c_i).      */
/* ------------------------------------------------------------------ */
void op_bernstein_derivative_d(const double *coef, int degree, double *out) {
    int i;
    double n;
    if (coef == NULL || out == NULL || degree < 1 || degree > OP_MATH_MAX_DEGREE) return;
    n = (double)degree;
    for (i = 0; i < degree; i++) {
        out[i] = n * (coef[i + 1] - coef[i]);
    }
}

void op_bernstein_derivative_c(const op_c64 *coef, int degree, op_c64 *out) {
    int i;
    double n;
    if (coef == NULL || out == NULL || degree < 1 || degree > OP_MATH_MAX_DEGREE) return;
    n = (double)degree;
    for (i = 0; i < degree; i++) {
        out[i].re = n * (coef[i + 1].re - coef[i].re);
        out[i].im = n * (coef[i + 1].im - coef[i].im);
    }
}

/* ------------------------------------------------------------------ */
/* Exact binomial table for n <= 16 (all values exact in binary64).   */
/* ------------------------------------------------------------------ */
static const double OP_BINOM_TABLE[17][17] = {
    {1},
    {1, 1},
    {1, 2, 1},
    {1, 3, 3, 1},
    {1, 4, 6, 4, 1},
    {1, 5, 10, 10, 5, 1},
    {1, 6, 15, 20, 15, 6, 1},
    {1, 7, 21, 35, 35, 21, 7, 1},
    {1, 8, 28, 56, 70, 56, 28, 8, 1},
    {1, 9, 36, 84, 126, 126, 84, 36, 9, 1},
    {1, 10, 45, 120, 210, 252, 210, 120, 45, 10, 1},
    {1, 11, 55, 165, 330, 462, 462, 330, 165, 55, 11, 1},
    {1, 12, 66, 220, 495, 792, 924, 792, 495, 220, 66, 12, 1},
    {1, 13, 78, 286, 715, 1287, 1716, 1716, 1287, 715, 286, 78, 13, 1},
    {1, 14, 91, 364, 1001, 2002, 3003, 3432, 3003, 2002, 1001, 364, 91, 14, 1},
    {1, 15, 105, 455, 1365, 3003, 5005, 6435, 6435, 5005, 3003, 1365, 455, 105,
     15, 1},
    {1, 16, 120, 560, 1820, 4368, 8008, 11440, 12870, 11440, 8008, 4368, 1820,
     560, 120, 16, 1}
};

double op_binomial(int n, int k) {
    if (n < 0 || n > 16) return op_quiet_nan();
    if (k < 0 || k > n) return 0.0; /* invalid indices contribute zero (§8.9) */
    return OP_BINOM_TABLE[n][k];
}

/* ------------------------------------------------------------------ */
/* Neumaier compensated accumulator (§12.7, §23.1).                   */
/* ------------------------------------------------------------------ */
void op_neumaier_init(op_neumaier *acc) {
    acc->sum = 0.0;
    acc->comp = 0.0;
}

void op_neumaier_add(op_neumaier *acc, double x) {
    double t = acc->sum + x;
    if (fabs(acc->sum) >= fabs(x)) {
        acc->comp += (acc->sum - t) + x;
    } else {
        acc->comp += (x - t) + acc->sum;
    }
    acc->sum = t;
}

double op_neumaier_value(const op_neumaier *acc) {
    return acc->sum + acc->comp;
}

/* ------------------------------------------------------------------ */
/* One-ULP neighbors by ordered integer bit stepping (§10.6).         */
/* IEEE-754 binary64 layout is verified by the §24.2 ABI tests.       */
/* ------------------------------------------------------------------ */
#define OP_BITS_POS_INF 0x7FF0000000000000ull

double op_next_up(double x) {
    uint64_t bits;
    if (x != x) return x; /* NaN passes through */
    if (x == 0.0) {
        /* +0.0 and -0.0 both step to the smallest positive subnormal. */
        double tiny;
        bits = 1u;
        memcpy(&tiny, &bits, sizeof tiny);
        return tiny;
    }
    memcpy(&bits, &x, sizeof bits);
    if ((bits >> 63) == 0) {
        if (bits == OP_BITS_POS_INF) return x; /* +inf is a fixed point */
        bits += 1u;                            /* positive: magnitude up */
    } else {
        bits -= 1u; /* negative: magnitude down; -inf steps to -DBL_MAX */
    }
    memcpy(&x, &bits, sizeof x);
    return x;
}

double op_next_down(double x) {
    return -op_next_up(-x);
}

double op_ulp(double x) {
    double a;
    if (x != x) return x; /* NaN passes through */
    a = fabs(x);
    if (!op_is_finite(a)) return a; /* ulp(+-inf) = +inf */
    return op_next_up(a) - a;
}

/* ------------------------------------------------------------------ */
/* Finiteness by exponent bits; safe under any FP mode (§23.1).       */
/* ------------------------------------------------------------------ */
int op_is_finite(double x) {
    uint64_t bits;
    memcpy(&bits, &x, sizeof bits);
    return (bits & OP_BITS_POS_INF) != OP_BITS_POS_INF;
}

int op_c64_is_finite(op_c64 z) {
    return op_is_finite(z.re) && op_is_finite(z.im);
}
