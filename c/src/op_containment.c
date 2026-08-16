/* Optiline — rational swept-rectangle half-space certificates (§10). */
#include <float.h>
#include <math.h>
#include <string.h>

#include "optiline/op_complex.h"
#include "optiline/op_containment.h"
#include "optiline/op_math.h"
#include "optiline/op_offset.h"
#include "optiline/op_span.h"

static void op_restrict_d9(const double src[10],double a,double b,double out[10]) {
    double left[10],right[10],tmp[10];
    int i;
    if (a>0.0) op_decasteljau_split_d(src,9,a,tmp,right);
    else for(i=0;i<10;i++) right[i]=src[i];
    if (b<1.0) {
        double t=(b-a)/(1.0-a);
        op_decasteljau_split_d(right,9,t,left,tmp);
        for(i=0;i<10;i++) out[i]=left[i];
    } else for(i=0;i<10;i++) out[i]=right[i];
}

void op_containment_g_coeffs(const op_span *sp,double nu0,double nu1,
                             op_c64 corner_a,const op_halfspace *hs,double g9[10]) {
    double full[10];
    int k,i,j;
    if(sp==NULL||hs==NULL||g9==NULL) return;
    for(k=0;k<10;k++) {
        op_c64 zr={0.0,0.0},qup={0.0,0.0};
        double rup=0.0,den=op_binomial(9,k);
        for(i=0;i<=5;i++) {
            j=k-i;
            if(j<0||j>4) continue;
            {
                double w=op_binomial(5,i)*op_binomial(4,j)/den;
                zr=op_c64_add(zr,op_c64_scale(sp->p[i],w*sp->r[j]));
            }
        }
        for(j=0;j<=4;j++) {
            int five=k-j;
            if(five<0||five>5) continue;
            {
                double w=op_binomial(4,j)*op_binomial(5,five)/den;
                rup+=w*sp->r[j];
                qup=op_c64_add(qup,op_c64_scale(sp->q[j],w));
            }
        }
        {
            op_c64 numerator=op_c64_add(zr,op_c64_mul(corner_a,qup));
            full[k]=hs->b*rup-hs->nx*numerator.re-hs->ny*numerator.im;
        }
    }
    op_restrict_d9(full,nu0,nu1,g9);
}

static int op_cell_interval(const op_span *sp,double u0,double u1,const op_cell *cell,
                            double x0,double x1,double y0,double y1,double *minimum) {
    int sl,sw,h,k;
    double minv=INFINITY;
    for(sl=0;sl<=1;sl++) for(sw=0;sw<=1;sw++) {
        op_c64 a={sl?x1:x0,sw?y1:y0};
        for(h=0;h<cell->hs_count;h++) {
            double g[10];
            op_containment_g_coeffs(sp,u0,u1,a,&cell->hs[h],g);
            for(k=0;k<10;k++) {
                minv=fmin(minv,g[k]);
                if(g[k]<0.0) return 0;
            }
        }
    }
    if(minimum!=NULL) *minimum=minv;
    return 1;
}

static op_result op_cert_rec(const op_track *track,const op_span *sp,double u0,double u1,
                             int32_t span_index,const uint16_t candidates[OP_MICRO_CANDIDATES],
                             double x0,double x1,double y0,double y1,int depth,
                             op_containment_proof *proof,
                             double *global_min) {
    int n;
    for(n=0;n<OP_MICRO_CANDIDATES;n++) {
        uint16_t ci=candidates[n];
        double bound;
        if(ci==OP_MICRO_CELL_NONE) break;
        if(ci<(uint16_t)track->cell_count &&
           op_cell_interval(sp,u0,u1,&track->cells[ci],x0,x1,y0,y1,&bound)) {
            *global_min=fmin(*global_min,bound);
            if(proof!=NULL) {
                if(proof->count>=OP_MAX_PROOF_STEPS) return OP_CORRIDOR_CERTIFICATE_FAILED;
                proof->step[proof->count].nu0=((double)span_index+u0)*OP_SPAN_H;
                proof->step[proof->count].nu1=((double)span_index+u1)*OP_SPAN_H;
                proof->step[proof->count].cell=ci;
                proof->step[proof->count].depth=depth;
                proof->count++;
            }
            return OP_OK;
        }
    }
    if(depth>=40) return OP_RECTANGLE_NOT_CONTAINED;
    {
        double mid=0.5*(u0+u1);
        op_result rc=op_cert_rec(track,sp,u0,mid,span_index,candidates,x0,x1,y0,y1,
                                 depth+1,proof,global_min);
        if(rc!=OP_OK) return rc;
        return op_cert_rec(track,sp,mid,u1,span_index,candidates,x0,x1,y0,y1,
                           depth+1,proof,global_min);
    }
}

op_result op_containment_certify(const op_track *track,const op_spline *line,
                                 const op_vehicle *veh,op_containment_proof *proof) {
    int32_t m,band,side;
    double minimum=INFINITY;
    double le,we;
    if(track==NULL||line==NULL||veh==NULL||track->cell_count<=0) return OP_INVALID_INPUT;
    if(proof!=NULL) { proof->count=0; proof->failure_partition=-1; proof->min_halfspace_bound=INFINITY; }
    le=veh->length+2.0*veh->margin;
    we=veh->width+2.0*veh->margin;
    for(m=0;m<OP_MICRO_COUNT;m++) {
        int32_t j=m/2;
        double u0=(m&1)?0.5:0.0,u1=(m&1)?1.0:0.5;
        for(band=0;band<16;band++) {
            double x0=-0.5*le+le*(double)band/16.0;
            double x1=-0.5*le+le*(double)(band+1)/16.0;
            for(side=0;side<4;side++) {
                double y0=-0.5*we+we*(double)side/4.0;
                double y1=-0.5*we+we*(double)(side+1)/4.0;
                op_result rc=op_cert_rec(track,&line->span[j],u0,u1,j,
                                         track->micro_cells[m],x0,x1,y0,y1,0,
                                         proof,&minimum);
                if(rc!=OP_OK) {
                    if(proof!=NULL) proof->failure_partition=64*m+4*band+side;
                    return rc;
                }
            }
        }
    }
    if(proof!=NULL) proof->min_halfspace_bound=minimum;
    return OP_OK;
}

op_result op_track_point_in_lane(const op_track *track,double px,double py,int *inside) {
    double best=INFINITY,signed_offset=0.0;
    int32_t j,k;
    if(track==NULL||inside==NULL||!op_is_finite(px)||!op_is_finite(py))
        return OP_INVALID_INPUT;
    for(j=0;j<OP_SPAN_COUNT;j++) for(k=0;k<=16;k++) {
        double u=(double)k/16.0;
        op_c64 p=op_span_point(&track->center.span[j],u),n;
        double d;
        if(op_span_frame(&track->center.span[j],u,NULL,&n,NULL)!=OP_OK) continue;
        d=hypot(px-p.re,py-p.im);
        if(d<best) { best=d; signed_offset=(px-p.re)*n.re+(py-p.im)*n.im; }
    }
    *inside=signed_offset<=track->d_left+1e-10 && signed_offset>=-track->d_right-1e-10;
    return OP_OK;
}

op_result op_cell_validate(const op_track *track,const op_cell *cell) {
    int h;
    (void)track;
    if(cell==NULL||cell->hs_count<3||cell->hs_count>OP_MAX_CELL_HALFSPACES)
        return OP_CORRIDOR_CERTIFICATE_FAILED;
    for(h=0;h<cell->hs_count;h++) {
        double n=hypot(cell->hs[h].nx,cell->hs[h].ny);
        if(!op_is_finite(n)||fabs(n-1.0)>1e-8) return OP_CORRIDOR_CERTIFICATE_FAILED;
    }
    return OP_OK;
}
