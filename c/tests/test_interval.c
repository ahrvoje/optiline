#include "optiline/op_interval.h"
#include "test_runner.h"

static void arithmetic_encloses(void){op_iv a=op_iv_make(1.0,2.0),b=op_iv_make(3.0,4.0),q;
    op_iv s=op_iv_add(a,b),p=op_iv_mul(a,b);OP_ASSERT(s.lo<=4.0&&s.hi>=6.0);OP_ASSERT(p.lo<=3.0&&p.hi>=8.0);
    OP_ASSERT_EQ_INT(op_iv_div(a,b,&q),OP_OK);OP_ASSERT(q.lo<=0.25&&q.hi>=2.0/3.0);
    OP_ASSERT_EQ_INT(op_iv_div(a,op_iv_make(-1.0,1.0),&q),OP_INVALID_INPUT);}
void op_register_interval(void){op_test_add("interval","arithmetic_encloses",arithmetic_encloses);}
