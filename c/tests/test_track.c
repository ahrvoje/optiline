#include <string.h>
#include "optiline/op_track.h"
#include "test_runner.h"

static void rejects_degenerate_source(void){static op_track out;static op_qr_workspace ws;op_track_source src;memset(&src,0,sizeof src);src.d_left=8;src.d_right=8;
    OP_ASSERT_EQ_INT(op_track_compile(&src,&out,&ws),OP_TRACK_CONSTRUCTION_FAILED);}
void op_register_track(void){op_test_add("track","rejects_degenerate",rejects_degenerate_source);}
