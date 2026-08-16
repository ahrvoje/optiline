#include "optiline/op_span.h"
#include "test_runner.h"

static void straight_span_closed_forms(void){op_span s;op_c64 b[3]={{1,0},{1,0},{1,0}},t,n;
    op_span_compile(&s,b,(op_c64){2,3});OP_ASSERT_NEAR(s.len,0.5,1e-15);
    OP_ASSERT_NEAR(op_span_arc_forward(&s,0.4),0.2,1e-15);
    OP_ASSERT_EQ_INT(op_span_frame(&s,0.5,&t,&n,NULL),OP_OK);
    OP_ASSERT_NEAR(t.re,1,1e-15);OP_ASSERT_NEAR(t.im,0,1e-15);OP_ASSERT_NEAR(n.re,0,1e-15);OP_ASSERT_NEAR(n.im,1,1e-15);}
void op_register_span(void){op_test_add("span","straight_closed_forms",straight_span_closed_forms);}
