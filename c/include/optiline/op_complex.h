/* Optiline — named static complex helpers (§5.3, §6.1).
 * The spec forbids <complex.h>; these POD helpers are the only complex
 * arithmetic used by the core. dot(a,b) = Re(conj(a) b), cross = Im(conj(a) b).
 */
#ifndef OPTILINE_OP_COMPLEX_H
#define OPTILINE_OP_COMPLEX_H

#include <math.h>
#include "optiline/op_types.h"

static inline op_c64 op_c64_make(double re, double im) { op_c64 z; z.re = re; z.im = im; return z; }
static inline op_c64 op_c64_add(op_c64 a, op_c64 b) { return op_c64_make(a.re + b.re, a.im + b.im); }
static inline op_c64 op_c64_sub(op_c64 a, op_c64 b) { return op_c64_make(a.re - b.re, a.im - b.im); }
static inline op_c64 op_c64_mul(op_c64 a, op_c64 b) {
    return op_c64_make(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}
static inline op_c64 op_c64_conj(op_c64 a) { return op_c64_make(a.re, -a.im); }
static inline op_c64 op_c64_scale(op_c64 a, double s) { return op_c64_make(a.re * s, a.im * s); }
static inline op_c64 op_c64_neg(op_c64 a) { return op_c64_make(-a.re, -a.im); }
/* dot(a,b) = Re(conj(a) * b) */
static inline double op_c64_dot(op_c64 a, op_c64 b) { return a.re * b.re + a.im * b.im; }
/* cross(a,b) = Im(conj(a) * b) */
static inline double op_c64_cross(op_c64 a, op_c64 b) { return a.re * b.im - a.im * b.re; }
/* multiplication by i: left rotation by 90 degrees */
static inline op_c64 op_c64_muli(op_c64 a) { return op_c64_make(-a.im, a.re); }
static inline double op_c64_abs2(op_c64 a) { return a.re * a.re + a.im * a.im; }
/* scaled-hypot magnitude (§23.1) */
static inline double op_c64_abs(op_c64 a) { return hypot(a.re, a.im); }

/* Periodic index wrap (§5.4): ((j mod n) + n) mod n for possibly negative j. */
static inline int32_t op_wrap_index(int32_t j, int32_t n) {
    int32_t m = j % n;
    return (m < 0) ? m + n : m;
}

/* Antiperiodic extended control lookup (§5.4): c_{j+kn} = (-1)^k c_j.
 * The sign is applied from the unwrapped index BEFORE the wrapped base
 * index is used; a plain modulo is incorrect.                          */
static inline op_c64 op_antiperiodic_control(const op_c64 *c, int32_t j, int32_t n) {
    int32_t r = j % n;
    int32_t q = j / n;
    if (r < 0) { r += n; q -= 1; }
    /* q is the floor quotient; odd |q| flips the sign. */
    return ((q & 1) != 0) ? op_c64_neg(c[r]) : c[r];
}

#endif /* OPTILINE_OP_COMPLEX_H */
