/* Optiline — convex micro-corridor construction for compiled tracks (§7.4). */
#include <math.h>
#include <string.h>

#include "optiline/op_containment.h"
#include "optiline/op_offset.h"
#include "optiline/op_span.h"
#include "optiline/op_track.h"

static op_result op_cell_from_quad(const op_c64 v[4],op_cell *cell) {
    double area=0.0;
    int i;
    memset(cell,0,sizeof *cell);
    for(i=0;i<4;i++) area+=v[i].re*v[(i+1)%4].im-v[i].im*v[(i+1)%4].re;
    cell->hs_count=4;
    for(i=0;i<4;i++) {
        op_c64 a=v[i],b=v[(i+1)%4];
        double dx=b.re-a.re,dy=b.im-a.im,len=hypot(dx,dy);
        double nx,ny;
        if(!(len>0.0)) return OP_CORRIDOR_CERTIFICATE_FAILED;
        if(area>0.0) { nx=dy/len; ny=-dx/len; }
        else { nx=-dy/len; ny=dx/len; }
        cell->hs[i].nx=nx; cell->hs[i].ny=ny;
        cell->hs[i].b=nx*a.re+ny*a.im;
    }
    return OP_OK;
}

static op_result op_track_frame_at_micro(const op_track *track,int32_t micro,
                                         op_c64 *point,op_c64 *normal) {
    int32_t wrapped=(micro%OP_MICRO_COUNT+OP_MICRO_COUNT)%OP_MICRO_COUNT;
    int32_t span=wrapped/2;
    double u=(wrapped&1)?0.5:0.0;
    *point=op_span_point(&track->center.span[span],u);
    return op_span_frame(&track->center.span[span],u,NULL,normal,NULL);
}

op_result op_track_build_cells(op_track *track) {
    int32_t m;
    if(track==NULL) return OP_INVALID_INPUT;
    track->cell_count=OP_MICRO_COUNT;
    for(m=0;m<OP_MICRO_COUNT;m++) {
        op_c64 p0,p1;
        op_c64 n0,n1,v[4];
        int k;
        if(op_track_frame_at_micro(track,m-1,&p0,&n0)!=OP_OK ||
           op_track_frame_at_micro(track,m+2,&p1,&n1)!=OP_OK)
            return OP_CORRIDOR_CERTIFICATE_FAILED;
        v[0].re=p0.re+track->d_left*n0.re; v[0].im=p0.im+track->d_left*n0.im;
        v[1].re=p1.re+track->d_left*n1.re; v[1].im=p1.im+track->d_left*n1.im;
        v[2].re=p1.re-track->d_right*n1.re;v[2].im=p1.im-track->d_right*n1.im;
        v[3].re=p0.re-track->d_right*n0.re;v[3].im=p0.im-track->d_right*n0.im;
        if(op_cell_from_quad(v,&track->cells[m])!=OP_OK) return OP_CORRIDOR_CERTIFICATE_FAILED;
        track->cells[m].gate_lo=(double)(m-1)/4.0;
        track->cells[m].gate_hi=(double)(m+2)/4.0;
        track->cells[m].neighbor_count=2;
        track->cells[m].neighbors[0]=(m+OP_MICRO_COUNT-1)%OP_MICRO_COUNT;
        track->cells[m].neighbors[1]=(m+1)%OP_MICRO_COUNT;
        for(k=0;k<OP_MICRO_CANDIDATES;k++) track->micro_cells[m][k]=OP_MICRO_CELL_NONE;
        track->micro_cells[m][0]=(uint16_t)m;
        track->micro_cells[m][1]=(uint16_t)((m+OP_MICRO_COUNT-1)%OP_MICRO_COUNT);
        track->micro_cells[m][2]=(uint16_t)((m+1)%OP_MICRO_COUNT);
        track->micro_cells[m][3]=(uint16_t)((m+OP_MICRO_COUNT-2)%OP_MICRO_COUNT);
        track->micro_cells[m][4]=(uint16_t)((m+2)%OP_MICRO_COUNT);
        track->micro_cells[m][5]=(uint16_t)((m+OP_MICRO_COUNT-3)%OP_MICRO_COUNT);
        track->micro_cells[m][6]=(uint16_t)((m+3)%OP_MICRO_COUNT);
        track->micro_cells[m][7]=(uint16_t)((m+OP_MICRO_COUNT-4)%OP_MICRO_COUNT);
    }
    return OP_OK;
}
