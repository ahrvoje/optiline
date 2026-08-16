/* Optiline — outward-rounded closed interval arithmetic (§10.6). */
#ifndef OPTILINE_OP_INTERVAL_H
#define OPTILINE_OP_INTERVAL_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct op_iv { double lo; double hi; } op_iv;

op_iv op_iv_point(double x);          /* enclosing one-ULP interval of a parsed value */
op_iv op_iv_make(double lo, double hi);
op_iv op_iv_add(op_iv x, op_iv y);
op_iv op_iv_sub(op_iv x, op_iv y);
op_iv op_iv_mul(op_iv x, op_iv y);
/* Division is forbidden when 0 is inside y; returns OP_INVALID_INPUT then. */
op_result op_iv_div(op_iv x, op_iv y, op_iv *out);
op_iv op_iv_neg(op_iv x);
op_iv op_iv_abs(op_iv x);
op_iv op_iv_sqr(op_iv x);
op_iv op_iv_hull(op_iv x, op_iv y);
int   op_iv_contains_zero(op_iv x);
double op_iv_width(op_iv x);

/* Complex interval pair used by containment and self-intersection code. */
typedef struct op_civ { op_iv re; op_iv im; } op_civ;
op_civ op_civ_add(op_civ a, op_civ b);
op_civ op_civ_sub(op_civ a, op_civ b);
op_civ op_civ_mul(op_civ a, op_civ b);
op_iv  op_civ_dot(op_civ a, op_civ b);
op_iv  op_civ_cross(op_civ a, op_civ b);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_INTERVAL_H */
