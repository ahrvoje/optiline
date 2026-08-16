#include "optiline/op_construction.h"
#include "test_runner.h"

static void gram_and_phi(void){op_c64 b[3]={{1,0},{1,0},{1,0}},p=op_construction_phi(b),v[3];
    OP_ASSERT_NEAR(OP_GRAM[0],0.2,0);OP_ASSERT_NEAR(OP_GRAM[4],2.0/15.0,1e-16);
    OP_ASSERT_NEAR(p.re,0.5,1e-15);OP_ASSERT_NEAR(p.im,0,0);op_construction_phi_grad(b,v);OP_ASSERT_NEAR(v[1].re,1.0/3.0,1e-15);}
void op_register_gram(void){op_test_add("gram","exact_displacement",gram_and_phi);}
