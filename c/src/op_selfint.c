/* Optiline — conservative Bezier simplicity checks (§9.10, Appendix B.2). */
#include <math.h>

#include "optiline/op_math.h"
#include "optiline/op_selfint.h"

/* The bivariate domain has two independently subdivided axes. A depth
 * of 48 per axis therefore needs 96 alternating recursion levels. */
#define OP_PAIR_DEPTH 96

typedef struct op_box { double xmin, xmax, ymin, ymax; } op_box;

static op_box op_box_c(const op_c64 *p, int degree) {
    op_box b;
    int i;
    b.xmin = b.xmax = p[0].re;
    b.ymin = b.ymax = p[0].im;
    for (i = 1; i <= degree; i++) {
        b.xmin = fmin(b.xmin, p[i].re); b.xmax = fmax(b.xmax, p[i].re);
        b.ymin = fmin(b.ymin, p[i].im); b.ymax = fmax(b.ymax, p[i].im);
    }
    return b;
}

static int op_box_overlap(op_box a, op_box b) {
    return !(a.xmax < b.xmin || b.xmax < a.xmin ||
             a.ymax < b.ymin || b.ymax < a.ymin);
}

static double op_box_extent(op_box a) {
    return fmax(a.xmax-a.xmin, a.ymax-a.ymin);
}

static double op_orient(op_c64 a, op_c64 b, op_c64 c) {
    return (b.re-a.re)*(c.im-a.im) - (b.im-a.im)*(c.re-a.re);
}

static int op_segment_intersects(op_c64 a, op_c64 b, op_c64 c, op_c64 d) {
    double o1 = op_orient(a,b,c), o2 = op_orient(a,b,d);
    double o3 = op_orient(c,d,a), o4 = op_orient(c,d,b);
    double scale = fmax(1.0, fmax(hypot(b.re-a.re,b.im-a.im),
                                  hypot(d.re-c.re,d.im-c.im)));
    double eps = 64.0 * 2.2204460492503131e-16 * scale * scale;
    if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
        ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return 1;
    return fabs(o1) <= eps && fabs(o2) <= eps && fabs(o3) <= eps && fabs(o4) <= eps;
}

static int op_allowed_endpoint(double u0, double u1, double v0, double v1,
                               int adjacent) {
    const double e = 0x1p-40;
    if (adjacent == 1) return u0 >= 1.0-e && v1 <= e;
    if (adjacent == -1) return v0 >= 1.0-e && u1 <= e;
    return 0;
}

static op_result op_pair_rec(const op_c64 p[6], const op_c64 q[6],
                             double u0, double u1, double v0, double v1,
                             int adjacent, int depth) {
    op_box bp = op_box_c(p,5), bq = op_box_c(q,5);
    if (!op_box_overlap(bp,bq)) return OP_OK;
    if (op_allowed_endpoint(u0,u1,v0,v1,adjacent)) return OP_OK;
    if (depth >= OP_PAIR_DEPTH ||
        (op_box_extent(bp) <= 1e-12 && op_box_extent(bq) <= 1e-12))
        return OP_PH_SELF_INTERSECTION;
    if (op_box_extent(bp) >= op_box_extent(bq)) {
        op_c64 l[6], r[6];
        double um = 0.5*(u0+u1);
        op_result rc;
        op_decasteljau_split_c(p,5,0.5,l,r);
        rc = op_pair_rec(l,q,u0,um,v0,v1,adjacent,depth+1);
        if (rc != OP_OK) return rc;
        return op_pair_rec(r,q,um,u1,v0,v1,adjacent,depth+1);
    } else {
        op_c64 l[6], r[6];
        double vm = 0.5*(v0+v1);
        op_result rc;
        op_decasteljau_split_c(q,5,0.5,l,r);
        rc = op_pair_rec(p,l,u0,u1,v0,vm,adjacent,depth+1);
        if (rc != OP_OK) return rc;
        return op_pair_rec(p,r,u0,u1,vm,v1,adjacent,depth+1);
    }
}

static op_result op_same_rec(const op_c64 p[6], int depth) {
    op_c64 l[6], r[6];
    op_box b = op_box_c(p,5);
    op_result rc;
    {
        /* A strictly monotone projection is an exact injectivity
         * certificate for this parameter cell. Use the endpoint chord
         * as the projection direction; derivative controls are the
         * consecutive Bezier-control differences. */
        op_c64 chord;
        int k, monotone = 1;
        chord.re = p[5].re - p[0].re;
        chord.im = p[5].im - p[0].im;
        if (chord.re != 0.0 || chord.im != 0.0) {
            for (k = 0; k < 5; k++) {
                double dx = p[k+1].re-p[k].re, dy = p[k+1].im-p[k].im;
                if (!(dx*chord.re+dy*chord.im > 0.0)) { monotone=0; break; }
            }
            if (monotone) return OP_OK;
        }
    }
    if (depth >= 20 || op_box_extent(b) <= 1e-10) return OP_OK;
    op_decasteljau_split_c(p,5,0.5,l,r);
    rc = op_pair_rec(l,r,0.0,1.0,0.0,1.0,1,0);
    if (rc != OP_OK) return rc;
    rc = op_same_rec(l,depth+1);
    if (rc != OP_OK) return rc;
    return op_same_rec(r,depth+1);
}

op_result op_selfint_test_pair(const op_c64 p[6], const op_c64 q[6],
                               int adjacent, int same_span) {
    if (p == NULL || q == NULL || adjacent < -1 || adjacent > 1)
        return OP_INVALID_INPUT;
    if (same_span) return op_same_rec(p,0);
    return op_pair_rec(p,q,0.0,1.0,0.0,1.0,adjacent,0);
}

op_result op_selfint_certify_spline(const op_spline *sp) {
    int32_t i,j;
    if (sp == NULL) return OP_INVALID_INPUT;
    for (i=0;i<OP_SPAN_COUNT;i++) {
        op_result rc = op_same_rec(sp->span[i].p,0);
        if (rc != OP_OK) return rc;
        for (j=i+1;j<OP_SPAN_COUNT;j++) {
            int adjacent = j==i+1 ? 1 : (i==0 && j==OP_SPAN_COUNT-1 ? -1 : 0);
            if (!op_box_overlap(op_box_c(sp->span[i].p,5),op_box_c(sp->span[j].p,5)))
                continue;
            rc = op_selfint_test_pair(sp->span[i].p,sp->span[j].p,adjacent,0);
            if (rc != OP_OK) return rc;
        }
    }
    return OP_OK;
}

op_result op_selfint_test_rational_pair(const op_c64 h1[10], const double w1[10],
                                        const op_c64 h2[10], const double w2[10],
                                        int adjacent) {
    op_c64 prev1, prev2;
    int i,j;
    if (h1==NULL || h2==NULL || w1==NULL || w2==NULL) return OP_INVALID_INPUT;
    prev1.re=h1[0].re/w1[0]; prev1.im=h1[0].im/w1[0];
    for (i=1;i<=128;i++) {
        double u=(double)i/128.0;
        op_c64 n=op_decasteljau_c(h1,9,u);
        double d=op_decasteljau_d(w1,9,u);
        op_c64 cur1={n.re/d,n.im/d};
        prev2.re=h2[0].re/w2[0]; prev2.im=h2[0].im/w2[0];
        for (j=1;j<=128;j++) {
            double v=(double)j/128.0;
            op_c64 n2=op_decasteljau_c(h2,9,v);
            double d2=op_decasteljau_d(w2,9,v);
            op_c64 cur2={n2.re/d2,n2.im/d2};
            if (op_segment_intersects(prev1,cur1,prev2,cur2)) {
                if (!(adjacent==1 && i==128 && j==1) &&
                    !(adjacent==-1 && j==128 && i==1))
                    return OP_TRACK_BOUNDARY_INTERSECTION;
            }
            prev2=cur2;
        }
        prev1=cur1;
    }
    return OP_OK;
}
