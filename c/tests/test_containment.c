#include "optiline/op_containment.h"
#include "optiline/op_span.h"
#include "test_runner.h"

static void halfspace_coefficients(void){op_span s;op_c64 b[3]={{1,0},{1,0},{1,0}};op_halfspace hs={1,0,1};double g[10];int i;
    op_span_compile(&s,b,(op_c64){0,0});op_containment_g_coeffs(&s,0,1,(op_c64){0,0},&hs,g);
    for(i=0;i<10;i++)OP_ASSERT(g[i]>=0.49);}
void op_register_containment(void){op_test_add("containment","degree9_halfspace",halfspace_coefficients);}
