#include "optiline/op_optimizer.h"
#include "test_runner.h"

static void philox_vector_and_reflect(void){op_philox_ctr c={{0,0,0,0}};op_philox_key k={{0,0}};uint32_t o[4];op_philox4x32_10(c,k,o);
    OP_ASSERT_EQ_INT(o[0],0x6627e8d5u);OP_ASSERT_EQ_INT(o[1],0xe169c58du);OP_ASSERT_EQ_INT(o[2],0xbc57ac4cu);OP_ASSERT_EQ_INT(o[3],0x9b00dbd8u);
    OP_ASSERT_NEAR(op_reflect(3,-1,1),-1,0);OP_ASSERT(op_optimizer_tau(0)<op_optimizer_tau(31));}
void op_register_optimizer(void){op_test_add("optimizer","deterministic_primitives",philox_vector_and_reflect);}
