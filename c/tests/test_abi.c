#include <stddef.h>
#include "optiline/op_abi.h"
#include "test_runner.h"

static void fixed_layout(void){OP_ASSERT_EQ_INT(sizeof(op_gpu_chain_state),1312);OP_ASSERT_EQ_INT(offsetof(op_gpu_chain_state,genotype),32);
    OP_ASSERT_EQ_INT(offsetof(op_gpu_chain_state,preimage),288);OP_ASSERT_EQ_INT(sizeof(op_gpu_track_header),128);OP_ASSERT_EQ_INT(sizeof(op_gpu_best_record),1296);}
void op_register_abi(void){op_test_add("abi","wgsl_record_layout",fixed_layout);}
