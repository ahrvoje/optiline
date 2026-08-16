#include <string.h>
#include "optiline/op_construction.h"
#include "test_runner.h"

static void qr_minimum_norm(void){double a[4]={1,0,0,1},f[2]={2,-3},d[2];op_qr_workspace ws;memset(&ws,0,sizeof ws);
    OP_ASSERT_EQ_INT(op_qr_min_norm_step(a,2,2,f,1e-12,d,&ws),OP_OK);OP_ASSERT_NEAR(d[0],-2,1e-14);OP_ASSERT_NEAR(d[1],3,1e-14);}
void op_register_construction(void){op_test_add("construction","qr_square",qr_minimum_norm);}
