#include "optiline/op_playback.h"
#include "optiline/op_span.h"
#include "test_runner.h"

static void inverse_straight_span(void){op_span s;op_spline line;op_arc_lut lut,all[OP_SPAN_COUNT];op_c64 b[3]={{2,0},{2,0},{2,0}},point;double u;int32_t span;int i;
    op_span_compile(&s,b,(op_c64){0,0});op_playback_build_lut(&s,&lut);OP_ASSERT_EQ_INT(op_arc_length_inverse(&s,&lut,0.6,&u),OP_OK);OP_ASSERT_NEAR(u,0.3,1e-13);
    for(i=0;i<OP_SPAN_COUNT;i++){op_span_compile(&line.span[i],b,(op_c64){2.0*i,0});op_playback_build_lut(&line.span[i],&all[i]);line.cum_len[i]=2.0*i;}
    line.cum_len[OP_SPAN_COUNT]=2.0*OP_SPAN_COUNT;line.total_len=line.cum_len[OP_SPAN_COUNT];
    OP_ASSERT_EQ_INT(op_point_at_distance(&line,all,2.5,&span,&u,&point),OP_OK);OP_ASSERT_EQ_INT(span,1);OP_ASSERT_NEAR(point.re,2.5,1e-12);}
void op_register_playback(void){op_test_add("playback","inverse_straight",inverse_straight_span);}
