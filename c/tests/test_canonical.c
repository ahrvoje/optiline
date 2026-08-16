#include <string.h>
#include "optiline/op_canonical.h"
#include "test_runner.h"

static void writer_and_hash(void){char b[128];size_t n;uint8_t d[32];op_json_writer w;op_sha256 s;
    op_json_init(&w,b,sizeof b);op_json_begin_object(&w);op_json_key(&w,"a");op_json_begin_array(&w);op_json_int(&w,1);op_json_string(&w,"x\n");op_json_end_array(&w);op_json_key(&w,"z");op_json_number(&w,-0.0);op_json_end_object(&w);
    OP_ASSERT_EQ_INT(op_json_finish(&w,&n),OP_OK);OP_ASSERT(strcmp(b,"{\"a\":[1,\"x\\n\"],\"z\":0}")==0);
    op_sha256_init(&s);op_sha256_update(&s,(const uint8_t *)"abc",3);op_sha256_final(&s,d);OP_ASSERT_EQ_INT(d[0],0xba);OP_ASSERT_EQ_INT(d[31],0xad);}
void op_register_canonical(void){op_test_add("canonical","json_and_sha256",writer_and_hash);}
