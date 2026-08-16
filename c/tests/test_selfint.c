#include "optiline/op_selfint.h"
#include "test_runner.h"

static void line(op_c64 p[6],double x0,double y0,double x1,double y1){int i;for(i=0;i<6;i++){double t=(double)i/5;p[i].re=x0+t*(x1-x0);p[i].im=y0+t*(y1-y0);}}
static void pair_classification(void){op_c64 a[6],b[6];line(a,0,0,1,1);line(b,0,1,1,0);
    OP_ASSERT_EQ_INT(op_selfint_test_pair(a,b,0,0),OP_PH_SELF_INTERSECTION);line(b,2,0,3,1);OP_ASSERT_EQ_INT(op_selfint_test_pair(a,b,0,0),OP_OK);}
void op_register_selfint(void){op_test_add("selfint","crossing_and_separate",pair_classification);}
