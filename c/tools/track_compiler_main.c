/* Optiline native track compiler smoke tool. The web compiler uses the same core. */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "optiline/op_selfint.h"
#include "optiline/op_track.h"

int main(int argc,char **argv){static op_track track;static op_qr_workspace ws;op_track_source src;int i,j;op_result rc;
    (void)argc;(void)argv;memset(&src,0,sizeof src);memcpy(src.id,"compiler-smoke",15);src.direction_ccw=1;src.d_left=8;src.d_right=8;
    for(i=0;i<OP_GATE_COUNT;i++){double a=6.2831853071795864769*i/OP_GATE_COUNT;src.gates[i].re=100*cos(a);src.gates[i].im=70*sin(a);}
    rc=op_track_compile(&src,&track,&ws);if(rc!=OP_OK){fprintf(stderr,"track compilation failed: %d",(int)rc);if(rc==OP_PH_SELF_INTERSECTION){for(i=0;i<OP_SPAN_COUNT;i++){if(op_selfint_test_pair(track.center.span[i].p,track.center.span[i].p,0,1)!=OP_OK){fprintf(stderr," (span %d)",i);break;}for(j=i+1;j<OP_SPAN_COUNT;j++){int adjacent=j==i+1?1:(i==0&&j==OP_SPAN_COUNT-1?-1:0);if(op_selfint_test_pair(track.center.span[i].p,track.center.span[j].p,adjacent,0)!=OP_OK){fprintf(stderr," (pair %d,%d)",i,j);i=OP_SPAN_COUNT;break;}}}}fputc('\n',stderr);return (int)rc;}
    printf("{\"cellCount\":%d,\"id\":\"%s\",\"lapLengthM\":%.17g,\"spanCount\":128}\n",track.cell_count,track.id,track.center.total_len);return 0;}
