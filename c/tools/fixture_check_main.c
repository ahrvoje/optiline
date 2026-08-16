/* Optiline deterministic primitive fixture check. */
#include <stdio.h>
#include "optiline/op_optimizer.h"

int main(void){op_philox_ctr c={{0,0,0,0}};op_philox_key k={{0,0}};uint32_t o[4];op_philox4x32_10(c,k,o);
    if(o[0]!=0x6627e8d5u||o[1]!=0xe169c58du||o[2]!=0xbc57ac4cu||o[3]!=0x9b00dbd8u)return 1;
    puts("Philox4x32-10 fixture: pass");return 0;}
