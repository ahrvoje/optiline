/* Optiline — source-track PH compilation and certificate aggregation (§7). */
#include <math.h>
#include <string.h>

#include "optiline/op_construction.h"
#include "optiline/op_offset.h"
#include "optiline/op_regularity.h"
#include "optiline/op_selfint.h"
#include "optiline/op_span.h"
#include "optiline/op_track.h"

op_result op_track_compile(const op_track_source *src,op_track *out,
                           op_qr_workspace *ws) {
    int32_t free_idx[OP_SPAN_COUNT],constraints[OP_GATE_COUNT];
    double xmin,xmax,ymin,ymax,residual,area;
    int32_t i;
    op_result rc;
    if(src==NULL||out==NULL||ws==NULL||src->start_gate!=0||
       !(src->d_left>0.0)||!(src->d_right>0.0)) return OP_INVALID_INPUT;
    memset(out,0,sizeof *out);
    memcpy(out->id,src->id,sizeof out->id);
    memcpy(out->gates,src->gates,sizeof out->gates);
    out->d_left=src->d_left; out->d_right=src->d_right;
    out->direction_ccw=src->direction_ccw?1:0; out->start_gate=0;
    xmin=xmax=src->gates[0].re; ymin=ymax=src->gates[0].im;
    for(i=0;i<OP_GATE_COUNT;i++) {
        xmin=fmin(xmin,src->gates[i].re);xmax=fmax(xmax,src->gates[i].re);
        ymin=fmin(ymin,src->gates[i].im);ymax=fmax(ymax,src->gates[i].im);
        free_idx[i]=i; constraints[i]=i;
    }
    for(i=OP_GATE_COUNT;i<OP_SPAN_COUNT;i++) free_idx[i]=i;
    out->origin_x=0.5*(xmin+xmax); out->origin_y=0.5*(ymin+ymax);
    out->scale_h=fmax(xmax-xmin,ymax-ymin);
    if(!(out->scale_h>0.0)) return OP_TRACK_CONSTRUCTION_FAILED;
    rc=op_construction_seed(src->gates,out->center.c);
    if(rc!=OP_OK) return rc;
    rc=op_construction_project(out->center.c,src->gates,free_idx,OP_SPAN_COUNT,
                               constraints,OP_GATE_COUNT,1e-12,40,
                               1e-10*out->scale_h,ws);
    if(rc!=OP_OK) return rc;
    rc=op_spline_compile(&out->center,src->gates);
    if(rc!=OP_OK) return rc;
    rc=op_construction_verify(&out->center,src->gates,1e-10*out->scale_h,
                              out->center.total_len/OP_PERIOD,&residual);
    if(rc!=OP_OK) return rc;
    rc=op_selfint_certify_spline(&out->center);
    if(rc!=OP_OK) return rc;
    area=op_spline_signed_area(&out->center);
    if(!(fabs(area)>0.0)||((area>0.0)!=(src->direction_ccw!=0)))
        return OP_TRACK_CONSTRUCTION_FAILED;
    rc=op_curvature_radii(&out->center,&out->kappa_min,&out->kappa_max,
                          &out->rho_left,&out->rho_right);
    if(rc!=OP_OK) return rc;
    if(src->d_left>=out->rho_left||src->d_right>=out->rho_right)
        return OP_TRACK_OFFSET_CUSP;
    rc=op_offset_curve_build(&out->center,src->d_left,src->direction_ccw?1:-1,
                             &out->left_boundary);
    if(rc!=OP_OK) return rc;
    rc=op_offset_curve_build(&out->center,-src->d_right,src->direction_ccw?1:-1,
                             &out->right_boundary);
    if(rc!=OP_OK) return rc;
    return op_track_build_cells(out);
}

op_result op_track_validate(const op_track *track,op_qr_workspace *ws) {
    double minw,kmin,kmax,rl,rr;
    op_result rc;
    (void)ws;
    if(track==NULL||!(track->scale_h>0.0)||track->cell_count<=0) return OP_INVALID_INPUT;
    rc=op_regularity_certify_spline(&track->center,track->center.total_len/OP_PERIOD,&minw);
    if(rc!=OP_OK) return rc;
    rc=op_selfint_certify_spline(&track->center);
    if(rc!=OP_OK) return rc;
    rc=op_curvature_radii(&track->center,&kmin,&kmax,&rl,&rr);
    if(rc!=OP_OK) return rc;
    if(track->d_left>=rl||track->d_right>=rr) return OP_TRACK_OFFSET_CUSP;
    return OP_OK;
}
