/* Optiline — tests for op_math.c (§8.5, §10.6, §23.1, §24.1). */
#include <float.h>
#include <math.h>
#include <string.h>

#include "optiline/op_math.h"
#include "test_runner.h"

/* Deterministic pseudo-random doubles in [-1, 1). */
static uint64_t g_state = 0x9E3779B97F4A7C15ull;

static double rnd(void) {
    g_state = g_state * 6364136223846793005ull + 1442695040888963407ull;
    return ((double)(g_state >> 11) * (1.0 / 9007199254740992.0)) * 2.0 - 1.0;
}

static double bits_to_double(uint64_t bits) {
    double x;
    memcpy(&x, &bits, sizeof x);
    return x;
}

/* Bernstein evaluation in Horner-style closed form: the non-authoritative
 * cross-check sum C(n,k) c_k nu^k (1-nu)^(n-k).                          */
static double bernstein_direct_d(const double *coef, int degree, double nu) {
    double s = 1.0 - nu;
    double acc = 0.0;
    double pw = 1.0;
    int k;
    double spow[17];
    spow[degree] = 1.0;
    for (k = degree - 1; k >= 0; k--) spow[k] = spow[k + 1] * s;
    for (k = 0; k <= degree; k++) {
        acc += op_binomial(degree, k) * coef[k] * pw * spow[k];
        pw *= nu;
    }
    return acc;
}

/* ------------------------------------------------------------------ */
static void test_decasteljau_matches_direct(void) {
    double coef[10];
    int degree, k, s;
    for (degree = 1; degree <= 9; degree++) {
        for (k = 0; k <= degree; k++) coef[k] = 4.0 * rnd();
        for (s = 0; s <= 16; s++) {
            double nu = (double)s / 16.0;
            double a = op_decasteljau_d(coef, degree, nu);
            double b = bernstein_direct_d(coef, degree, nu);
            OP_ASSERT_NEAR(a, b, 1e-13 * (1.0 + fabs(b)));
        }
    }
}

static void test_decasteljau_complex_matches_direct(void) {
    op_c64 coef[10];
    double re[10], im[10];
    int degree, k, s;
    for (degree = 1; degree <= 9; degree++) {
        for (k = 0; k <= degree; k++) {
            re[k] = 3.0 * rnd();
            im[k] = 3.0 * rnd();
            coef[k].re = re[k];
            coef[k].im = im[k];
        }
        for (s = 0; s <= 16; s++) {
            double nu = (double)s / 16.0;
            op_c64 z = op_decasteljau_c(coef, degree, nu);
            OP_ASSERT_NEAR(z.re, op_decasteljau_d(re, degree, nu), 1e-14);
            OP_ASSERT_NEAR(z.im, op_decasteljau_d(im, degree, nu), 1e-14);
        }
    }
}

static void test_split_consistency(void) {
    double coef[7], left[7], right[7];
    double cut = 0.3;
    int k, s;
    for (k = 0; k <= 6; k++) coef[k] = 2.0 * rnd();
    op_decasteljau_split_d(coef, 6, cut, left, right);
    for (s = 0; s <= 10; s++) {
        double u = (double)s / 10.0;
        OP_ASSERT_NEAR(op_decasteljau_d(left, 6, u),
                       op_decasteljau_d(coef, 6, cut * u), 1e-13);
        OP_ASSERT_NEAR(op_decasteljau_d(right, 6, u),
                       op_decasteljau_d(coef, 6, cut + (1.0 - cut) * u), 1e-13);
    }
    /* Complex split against the double split of both components. */
    {
        op_c64 cc[4], cl[4], cr[4];
        double dre[4], dlre[4], drre[4];
        for (k = 0; k <= 3; k++) {
            dre[k] = 2.0 * rnd();
            cc[k].re = dre[k];
            cc[k].im = -dre[k];
        }
        op_decasteljau_split_c(cc, 3, 0.5, cl, cr);
        op_decasteljau_split_d(dre, 3, 0.5, dlre, drre);
        for (k = 0; k <= 3; k++) {
            OP_ASSERT_NEAR(cl[k].re, dlre[k], 0.0);
            OP_ASSERT_NEAR(cl[k].im, -dlre[k], 0.0);
            OP_ASSERT_NEAR(cr[k].re, drre[k], 0.0);
            OP_ASSERT_NEAR(cr[k].im, -drre[k], 0.0);
        }
    }
}

static void test_elevation_identity(void) {
    double coef[5], up[6];
    op_c64 cc[5], cup[6];
    int k, s;
    for (k = 0; k <= 4; k++) {
        coef[k] = 3.0 * rnd();
        cc[k].re = coef[k];
        cc[k].im = 0.5 * coef[k];
    }
    op_bernstein_elevate_d(coef, 4, up);
    op_bernstein_elevate_c(cc, 4, cup);
    for (s = 0; s <= 12; s++) {
        double nu = (double)s / 12.0;
        double v = op_decasteljau_d(coef, 4, nu);
        op_c64 z = op_decasteljau_c(cup, 5, nu);
        OP_ASSERT_NEAR(op_decasteljau_d(up, 5, nu), v, 1e-13 * (1.0 + fabs(v)));
        OP_ASSERT_NEAR(z.re, v, 1e-13 * (1.0 + fabs(v)));
        OP_ASSERT_NEAR(z.im, 0.5 * v, 1e-13 * (1.0 + fabs(v)));
    }
}

static void test_derivative_coefficients(void) {
    double coef[6], der[5], rec[6];
    op_c64 cc[6], cder[5];
    int k, s;
    for (k = 0; k <= 5; k++) {
        coef[k] = 2.0 * rnd();
        cc[k].re = coef[k];
        cc[k].im = -2.0 * coef[k];
    }
    op_bernstein_derivative_d(coef, 5, der);
    op_bernstein_derivative_c(cc, 5, cder);
    /* Exact structural identity: D_k = n (c_{k+1} - c_k). */
    for (k = 0; k < 5; k++) {
        OP_ASSERT_NEAR(der[k], 5.0 * (coef[k + 1] - coef[k]), 0.0);
        OP_ASSERT_NEAR(cder[k].re, 5.0 * (cc[k + 1].re - cc[k].re), 0.0);
        OP_ASSERT_NEAR(cder[k].im, 5.0 * (cc[k + 1].im - cc[k].im), 0.0);
    }
    /* Anti-derivative reconstruction: c_0 + (1/n) partial sums of D. */
    rec[0] = coef[0];
    for (k = 0; k < 5; k++) rec[k + 1] = rec[k] + der[k] / 5.0;
    for (k = 0; k <= 5; k++) {
        OP_ASSERT_NEAR(rec[k], coef[k], 1e-14 * (1.0 + fabs(coef[k])));
    }
    /* Derivative polynomial matches a central difference of the source. */
    for (s = 1; s < 8; s++) {
        double nu = (double)s / 8.0;
        double h = 1e-6;
        double fd = (op_decasteljau_d(coef, 5, nu + h) -
                     op_decasteljau_d(coef, 5, nu - h)) / (2.0 * h);
        OP_ASSERT_NEAR(op_decasteljau_d(der, 4, nu), fd, 1e-7);
    }
}

static void test_binomial_table(void) {
    int n, k;
    OP_ASSERT_NEAR(op_binomial(0, 0), 1.0, 0.0);
    OP_ASSERT_NEAR(op_binomial(4, 2), 6.0, 0.0);
    OP_ASSERT_NEAR(op_binomial(9, 4), 126.0, 0.0);
    OP_ASSERT_NEAR(op_binomial(16, 8), 12870.0, 0.0);
    /* Invalid k contributes zero (§8.9). */
    OP_ASSERT_NEAR(op_binomial(5, -1), 0.0, 0.0);
    OP_ASSERT_NEAR(op_binomial(5, 6), 0.0, 0.0);
    /* Out-of-table n is NaN, never a wrong value. */
    OP_ASSERT(op_binomial(17, 1) != op_binomial(17, 1));
    /* Pascal identity across the whole table. */
    for (n = 2; n <= 16; n++) {
        for (k = 1; k < n; k++) {
            OP_ASSERT_NEAR(op_binomial(n, k),
                           op_binomial(n - 1, k - 1) + op_binomial(n - 1, k),
                           0.0);
        }
    }
}

static void test_nextup_nextdown_ulp(void) {
    double tiny = bits_to_double(1u);            /* smallest positive subnormal */
    double pinf = bits_to_double(0x7FF0000000000000ull);
    double ninf = bits_to_double(0xFFF0000000000000ull);
    double qnan = bits_to_double(0x7FF8000000000000ull);

    /* Zeros of both signs step to the same subnormal neighbors. */
    OP_ASSERT(op_next_up(0.0) == tiny);
    OP_ASSERT(op_next_up(-0.0) == tiny);
    OP_ASSERT(op_next_down(0.0) == -tiny);
    OP_ASSERT(op_next_down(-0.0) == -tiny);

    /* Subnormal stepping. */
    OP_ASSERT(op_next_up(tiny) == 2.0 * tiny);
    OP_ASSERT(op_next_down(2.0 * tiny) == tiny);
    OP_ASSERT(op_next_down(tiny) == 0.0);

    /* Normal neighbors around +-1. */
    OP_ASSERT(op_next_up(1.0) == 1.0 + DBL_EPSILON);
    OP_ASSERT(op_next_down(1.0) == 1.0 - DBL_EPSILON / 2.0);
    OP_ASSERT(op_next_up(-1.0) == -(1.0 - DBL_EPSILON / 2.0));
    OP_ASSERT(op_next_down(-1.0) == -(1.0 + DBL_EPSILON));

    /* Infinities. */
    OP_ASSERT(op_next_up(pinf) == pinf);
    OP_ASSERT(op_next_down(ninf) == ninf);
    OP_ASSERT(op_next_up(ninf) == -DBL_MAX);
    OP_ASSERT(op_next_down(pinf) == DBL_MAX);
    OP_ASSERT(op_next_up(DBL_MAX) == pinf);

    /* NaN passes through. */
    OP_ASSERT(op_next_up(qnan) != op_next_up(qnan));
    OP_ASSERT(op_next_down(qnan) != op_next_down(qnan));

    /* Round trips. */
    OP_ASSERT(op_next_down(op_next_up(1.5)) == 1.5);
    OP_ASSERT(op_next_up(op_next_down(-2.25)) == -2.25);
    OP_ASSERT(op_next_down(op_next_up(3.0 * tiny)) == 3.0 * tiny);

    /* ULP values. */
    OP_ASSERT(op_ulp(0.0) == tiny);
    OP_ASSERT(op_ulp(-0.0) == tiny);
    OP_ASSERT(op_ulp(1.0) == DBL_EPSILON);
    OP_ASSERT(op_ulp(-2.0) == 2.0 * DBL_EPSILON);
    OP_ASSERT(op_ulp(tiny) == tiny);
    OP_ASSERT(!op_is_finite(op_ulp(pinf)));
    OP_ASSERT(op_ulp(qnan) != op_ulp(qnan));

    /* Finiteness classification. */
    OP_ASSERT(op_is_finite(0.0));
    OP_ASSERT(op_is_finite(tiny));
    OP_ASSERT(op_is_finite(DBL_MAX));
    OP_ASSERT(!op_is_finite(pinf));
    OP_ASSERT(!op_is_finite(ninf));
    OP_ASSERT(!op_is_finite(qnan));
    {
        op_c64 z;
        z.re = 1.0;
        z.im = qnan;
        OP_ASSERT(!op_c64_is_finite(z));
        z.im = -2.0;
        OP_ASSERT(op_c64_is_finite(z));
    }
}

static void test_neumaier_ill_conditioned(void) {
    /* Catastrophic cancellation: naive summation loses the small terms. */
    double terms[4];
    op_neumaier acc;
    double naive = 0.0;
    int k;
    terms[0] = 1.0;
    terms[1] = 1e100;
    terms[2] = 1.0;
    terms[3] = -1e100;
    op_neumaier_init(&acc);
    for (k = 0; k < 4; k++) {
        naive += terms[k];
        op_neumaier_add(&acc, terms[k]);
    }
    OP_ASSERT(naive == 0.0); /* demonstrates the naive failure mode */
    OP_ASSERT(op_neumaier_value(&acc) == 2.0);

    /* Long alternating ill-conditioned sum: exact value is n * 0.1. */
    op_neumaier_init(&acc);
    for (k = 0; k < 100000; k++) {
        op_neumaier_add(&acc, 0.1);
        op_neumaier_add(&acc, 1e13);
        op_neumaier_add(&acc, -1e13);
    }
    OP_ASSERT_NEAR(op_neumaier_value(&acc), 10000.0, 1e-7);
}

void op_register_math(void) {
    op_test_add("math", "decasteljau_matches_direct", test_decasteljau_matches_direct);
    op_test_add("math", "decasteljau_complex_matches_direct",
                test_decasteljau_complex_matches_direct);
    op_test_add("math", "split_consistency", test_split_consistency);
    op_test_add("math", "elevation_identity", test_elevation_identity);
    op_test_add("math", "derivative_coefficients", test_derivative_coefficients);
    op_test_add("math", "binomial_table", test_binomial_table);
    op_test_add("math", "nextup_nextdown_ulp", test_nextup_nextdown_ulp);
    op_test_add("math", "neumaier_ill_conditioned", test_neumaier_ill_conditioned);
}
