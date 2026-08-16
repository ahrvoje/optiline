#include <string.h>
#include "optiline/op_offset.h"
#include "optiline/op_span.h"
#include "test_runner.h"

static void straight_offset(void){op_span s;op_c64 b[3]={{1,0},{1,0},{1,0}},z;op_offset_curve c;
    memset(&c,0,sizeof c);op_span_compile(&s,b,(op_c64){0,0});OP_ASSERT_EQ_INT(op_offset_span_build(&s,0,2,&c),OP_OK);
    OP_ASSERT_EQ_INT(c.count,1);z=op_offset_span_point(&c.spans[0],0.5);OP_ASSERT_NEAR(z.re,0.25,1e-14);OP_ASSERT_NEAR(z.im,2,1e-14);}
void op_register_offset(void){op_test_add("offset","straight_exact",straight_offset);}
