/* Optiline — Bernstein/de Casteljau primitives and compensated sums (§8.5, §23.1). */
#ifndef OPTILINE_OP_MATH_H
#define OPTILINE_OP_MATH_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Authoritative Bernstein evaluation is de Casteljau (§8.5, §23.1).
 * coef arrays are ascending-index Bernstein coefficients of the given degree. */
double op_decasteljau_d(const double *coef, int degree, double nu);
op_c64 op_decasteljau_c(const op_c64 *coef, int degree, double nu);

/* Split a Bernstein polynomial at nu into left/right coefficient sets.
 * left/right hold degree+1 entries each; in-place aliasing is not allowed. */
void op_decasteljau_split_d(const double *coef, int degree, double nu,
                            double *left, double *right);
void op_decasteljau_split_c(const op_c64 *coef, int degree, double nu,
                            op_c64 *left, op_c64 *right);

/* Degree elevation by one step; out has (degree+2) entries. */
void op_bernstein_elevate_c(const op_c64 *coef, int degree, op_c64 *out);
void op_bernstein_elevate_d(const double *coef, int degree, double *out);

/* Bernstein derivative coefficients: out has `degree` entries. */
void op_bernstein_derivative_c(const op_c64 *coef, int degree, op_c64 *out);
void op_bernstein_derivative_d(const double *coef, int degree, double *out);

/* Exact binomial C(n,k) as double for n <= 16 (compile-time table). */
double op_binomial(int n, int k);

/* Neumaier compensated accumulator (§12.7, §23.1). */
typedef struct op_neumaier { double sum; double comp; } op_neumaier;
void   op_neumaier_init(op_neumaier *acc);
void   op_neumaier_add(op_neumaier *acc, double x);
double op_neumaier_value(const op_neumaier *acc);

/* One-ULP neighbors by integer bit ordering; memcpy-based (§10.6). */
double op_next_up(double x);
double op_next_down(double x);
double op_ulp(double x);

/* Finite check that never uses fast-math-unsafe idioms. */
int op_is_finite(double x);
int op_c64_is_finite(op_c64 z);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_MATH_H */
