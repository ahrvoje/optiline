/* Optiline — outward-rounded closed interval arithmetic (§10.6). */
#include <math.h>

#include "optiline/op_interval.h"
#include "optiline/op_math.h"

static double op_min4(double a, double b, double c, double d) {
    return fmin(fmin(a, b), fmin(c, d));
}

static double op_max4(double a, double b, double c, double d) {
    return fmax(fmax(a, b), fmax(c, d));
}

op_iv op_iv_point(double x) {
    op_iv out;
    out.lo = op_next_down(x);
    out.hi = op_next_up(x);
    return out;
}

op_iv op_iv_make(double lo, double hi) {
    op_iv out;
    if (lo <= hi) {
        out.lo = lo;
        out.hi = hi;
    } else {
        out.lo = hi;
        out.hi = lo;
    }
    return out;
}

op_iv op_iv_add(op_iv x, op_iv y) {
    return op_iv_make(op_next_down(x.lo + y.lo), op_next_up(x.hi + y.hi));
}

op_iv op_iv_sub(op_iv x, op_iv y) {
    return op_iv_make(op_next_down(x.lo - y.hi), op_next_up(x.hi - y.lo));
}

op_iv op_iv_mul(op_iv x, op_iv y) {
    double a = x.lo * y.lo;
    double b = x.lo * y.hi;
    double c = x.hi * y.lo;
    double d = x.hi * y.hi;
    return op_iv_make(op_next_down(op_min4(a, b, c, d)),
                      op_next_up(op_max4(a, b, c, d)));
}

op_result op_iv_div(op_iv x, op_iv y, op_iv *out) {
    op_iv inv;
    if (out == NULL || op_iv_contains_zero(y)) return OP_INVALID_INPUT;
    inv.lo = op_next_down(1.0 / y.hi);
    inv.hi = op_next_up(1.0 / y.lo);
    *out = op_iv_mul(x, inv);
    return OP_OK;
}

op_iv op_iv_neg(op_iv x) {
    return op_iv_make(-x.hi, -x.lo);
}

op_iv op_iv_abs(op_iv x) {
    if (x.lo >= 0.0) return x;
    if (x.hi <= 0.0) return op_iv_neg(x);
    return op_iv_make(0.0, op_next_up(fmax(-x.lo, x.hi)));
}

op_iv op_iv_sqr(op_iv x) {
    op_iv a = op_iv_abs(x);
    return op_iv_make(op_next_down(a.lo * a.lo), op_next_up(a.hi * a.hi));
}

op_iv op_iv_hull(op_iv x, op_iv y) {
    return op_iv_make(fmin(x.lo, y.lo), fmax(x.hi, y.hi));
}

int op_iv_contains_zero(op_iv x) {
    return x.lo <= 0.0 && x.hi >= 0.0;
}

double op_iv_width(op_iv x) {
    return op_next_up(x.hi - x.lo);
}

op_civ op_civ_add(op_civ a, op_civ b) {
    op_civ out;
    out.re = op_iv_add(a.re, b.re);
    out.im = op_iv_add(a.im, b.im);
    return out;
}

op_civ op_civ_sub(op_civ a, op_civ b) {
    op_civ out;
    out.re = op_iv_sub(a.re, b.re);
    out.im = op_iv_sub(a.im, b.im);
    return out;
}

op_civ op_civ_mul(op_civ a, op_civ b) {
    op_civ out;
    out.re = op_iv_sub(op_iv_mul(a.re, b.re), op_iv_mul(a.im, b.im));
    out.im = op_iv_add(op_iv_mul(a.re, b.im), op_iv_mul(a.im, b.re));
    return out;
}

op_iv op_civ_dot(op_civ a, op_civ b) {
    return op_iv_add(op_iv_mul(a.re, b.re), op_iv_mul(a.im, b.im));
}

op_iv op_civ_cross(op_civ a, op_civ b) {
    return op_iv_sub(op_iv_mul(a.re, b.im), op_iv_mul(a.im, b.re));
}
