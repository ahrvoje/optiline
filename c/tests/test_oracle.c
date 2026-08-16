#include <string.h>
#include "test_runner.h"

static void fixture_path_is_injected(void){const char *p=op_test_fixture_dir();OP_ASSERT(p!=NULL);OP_ASSERT(strlen(p)>0);}
void op_register_oracle(void){op_test_add("oracle","fixture_path",fixture_path_is_injected);}
