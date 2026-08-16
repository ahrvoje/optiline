/* Optiline - allocation-free SHA-256 used by canonical fingerprints. */
#include <string.h>

#include "optiline/op_canonical.h"

static const uint32_t OP_SHA_K[64] = {
    0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
    0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
    0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
    0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
    0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
    0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
    0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
    0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
};

static uint32_t op_rotr(uint32_t x, uint32_t n) { return (x >> n) | (x << (32u - n)); }

static void op_sha256_block(op_sha256 *s, const uint8_t p[64]) {
    uint32_t w[64], a,b,c,d,e,f,g,h,t1,t2;
    int i;
    for (i=0;i<16;i++) w[i]=((uint32_t)p[4*i]<<24)|((uint32_t)p[4*i+1]<<16)|
                              ((uint32_t)p[4*i+2]<<8)|(uint32_t)p[4*i+3];
    for (i=16;i<64;i++) {
        uint32_t x=w[i-15], y=w[i-2];
        uint32_t s0=op_rotr(x,7)^op_rotr(x,18)^(x>>3);
        uint32_t s1=op_rotr(y,17)^op_rotr(y,19)^(y>>10);
        w[i]=w[i-16]+s0+w[i-7]+s1;
    }
    a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
    for (i=0;i<64;i++) {
        uint32_t s1=op_rotr(e,6)^op_rotr(e,11)^op_rotr(e,25);
        uint32_t ch=(e&f)^((~e)&g);
        uint32_t s0=op_rotr(a,2)^op_rotr(a,13)^op_rotr(a,22);
        uint32_t maj=(a&b)^(a&c)^(b&c);
        t1=h+s1+ch+OP_SHA_K[i]+w[i]; t2=s0+maj;
        h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
    }
    s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;
    s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}

void op_sha256_init(op_sha256 *s) {
    static const uint32_t init[8]={0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
                                   0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    memcpy(s->h,init,sizeof init);s->bits=0;s->fill=0;
}

void op_sha256_update(op_sha256 *s,const uint8_t *data,size_t n) {
    size_t take;
    if (s==NULL||(data==NULL&&n!=0)) return;
    s->bits+=(uint64_t)n*8u;
    while(n!=0) {
        take=64u-s->fill;if(take>n)take=n;
        memcpy(s->block+s->fill,data,take);s->fill+=(uint32_t)take;data+=take;n-=take;
        if(s->fill==64u){op_sha256_block(s,s->block);s->fill=0;}
    }
}

void op_sha256_final(op_sha256 *s,uint8_t digest[32]) {
    uint64_t bits;int i;
    bits=s->bits;s->block[s->fill++]=0x80u;
    if(s->fill>56u){while(s->fill<64u)s->block[s->fill++]=0;op_sha256_block(s,s->block);s->fill=0;}
    while(s->fill<56u)s->block[s->fill++]=0;
    for(i=7;i>=0;i--)s->block[s->fill++]=(uint8_t)(bits>>(8*i));
    op_sha256_block(s,s->block);
    for(i=0;i<8;i++){digest[4*i]=(uint8_t)(s->h[i]>>24);digest[4*i+1]=(uint8_t)(s->h[i]>>16);
                     digest[4*i+2]=(uint8_t)(s->h[i]>>8);digest[4*i+3]=(uint8_t)s->h[i];}
    memset(s,0,sizeof *s);
}
