#include "optiline/op_regularity.h"
#include "test_runner.h"

static void regularity_bounds(void){op_c64 good[3]={{2,0},{2,0},{2,0}},bad[3]={{-1,0},{0,0},{1,0}};double m=0;
    OP_ASSERT_EQ_INT(op_regularity_certify_span(good,1e-8,&m),OP_OK);OP_ASSERT(m>=4.0);
    OP_ASSERT_EQ_INT(op_regularity_certify_span(bad,1e-8,&m),OP_PH_IRREGULAR);}
void op_register_regularity(void){op_test_add("regularity","hull_certificate",regularity_bounds);}
