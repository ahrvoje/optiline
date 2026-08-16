/* Optiline playback-only WASIp1 reactor ABI. */
#include <stdint.h>
#include <string.h>

#include "optiline/op_playback.h"
#include "optiline/op_span.h"

#define OP_EXPORT(name) __attribute__((export_name(name)))

static double g_line_input[384];
static double g_frame[8];
static double g_error[18];
static op_spline g_line;
static op_arc_lut g_lut[OP_SPAN_COUNT];
static int g_loaded;
static const char g_version[]="optiline-c99-1";

static int32_t op_fail(op_result rc,double detail){g_error[0]=(double)rc;g_error[1]=1;g_error[2]=detail;return -(int32_t)rc;}
OP_EXPORT("op_ver") uintptr_t op_ver(void){return (uintptr_t)g_version;}
OP_EXPORT("op_ws_init") int32_t op_ws_init(void){memset(g_error,0,sizeof g_error);g_loaded=0;return 0;}
OP_EXPORT("op_buf_ptr") uintptr_t op_buf_ptr(int32_t r){if(r==0)return (uintptr_t)g_line_input;if(r==1)return (uintptr_t)g_frame;if(r==2)return (uintptr_t)g_error;return 0;}
OP_EXPORT("op_buf_len") uint32_t op_buf_len(int32_t r){if(r==0)return (uint32_t)sizeof g_line_input;if(r==1)return (uint32_t)sizeof g_frame;if(r==2)return (uint32_t)sizeof g_error;return 0;}
OP_EXPORT("op_err_detail") int32_t op_err_detail(void){return (int32_t)g_error[1];}

OP_EXPORT("op_line_load") int32_t op_line_load(void){op_c64 gates[OP_GATE_COUNT];int i;op_result rc;
    memset(&g_line,0,sizeof g_line);for(i=0;i<OP_SPAN_COUNT;i++){g_line.c[i].re=g_line_input[2*i];g_line.c[i].im=g_line_input[2*i+1];}
    for(i=0;i<OP_GATE_COUNT;i++){gates[i].re=g_line_input[256+2*i];gates[i].im=g_line_input[257+2*i];}
    rc=op_spline_compile(&g_line,gates);if(rc!=OP_OK)return op_fail(rc,0);
    for(i=0;i<OP_SPAN_COUNT;i++)op_playback_build_lut(&g_line.span[i],&g_lut[i]);g_loaded=1;return 0;}
OP_EXPORT("op_span_arc_forward_e") double op_span_arc_forward_e(int32_t span,double nu){if(!g_loaded||span<0||span>=OP_SPAN_COUNT)return -OP_INVALID_INPUT;return op_span_arc_forward(&g_line.span[span],nu);}
OP_EXPORT("op_span_length_e") double op_span_length_e(int32_t span){if(!g_loaded||span<0||span>=OP_SPAN_COUNT)return -OP_INVALID_INPUT;return g_line.span[span].len;}
OP_EXPORT("op_arc_inverse_e") double op_arc_inverse_e(int32_t span,double s){double u;op_result rc;if(!g_loaded||span<0||span>=OP_SPAN_COUNT)return -OP_INVALID_INPUT;
    rc=op_arc_length_inverse(&g_line.span[span],&g_lut[span],s,&u);if(rc!=OP_OK){op_fail(rc,(double)span);return -(double)rc;}return u;}
OP_EXPORT("op_point_at_distance_e") int32_t op_point_at_distance_e(double s){int32_t span;double u;op_c64 p;op_result rc;if(!g_loaded)return op_fail(OP_INVALID_INPUT,0);
    rc=op_point_at_distance(&g_line,g_lut,s,&span,&u,&p);if(rc!=OP_OK)return op_fail(rc,s);g_frame[0]=u;g_frame[1]=p.re;g_frame[2]=p.im;return span;}
OP_EXPORT("op_eval_frame_e") int32_t op_eval_frame_e(int32_t span,double u){op_c64 p,t,n;double k;op_result rc;if(!g_loaded||span<0||span>=OP_SPAN_COUNT)return op_fail(OP_INVALID_INPUT,(double)span);
    p=op_span_point(&g_line.span[span],u);rc=op_span_frame(&g_line.span[span],u,&t,&n,&k);if(rc!=OP_OK)return op_fail(rc,(double)span);
    g_frame[0]=p.re;g_frame[1]=p.im;g_frame[2]=t.re;g_frame[3]=t.im;g_frame[4]=k;return 0;}
