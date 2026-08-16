/* Optiline — Philox4x32-10 deterministic random generator (§13.6). */
#include <math.h>

#include "optiline/op_optimizer.h"

#define OP_PHILOX_M0 0xD2511F53u
#define OP_PHILOX_M1 0xCD9E8D57u
#define OP_PHILOX_W0 0x9E3779B9u
#define OP_PHILOX_W1 0xBB67AE85u

void op_philox4x32_10(op_philox_ctr ctr, op_philox_key key, uint32_t out[4]) {
    uint32_t c0 = ctr.v[0], c1 = ctr.v[1], c2 = ctr.v[2], c3 = ctr.v[3];
    uint32_t k0 = key.v[0], k1 = key.v[1];
    int round;
    for (round = 0; round < 10; round++) {
        uint64_t p0 = (uint64_t)OP_PHILOX_M0 * c0;
        uint64_t p1 = (uint64_t)OP_PHILOX_M1 * c2;
        uint32_t n0 = (uint32_t)(p1 >> 32) ^ c1 ^ k0;
        uint32_t n1 = (uint32_t)p1;
        uint32_t n2 = (uint32_t)(p0 >> 32) ^ c3 ^ k1;
        uint32_t n3 = (uint32_t)p0;
        c0 = n0; c1 = n1; c2 = n2; c3 = n3;
        k0 += OP_PHILOX_W0;
        k1 += OP_PHILOX_W1;
    }
    out[0] = c0; out[1] = c1; out[2] = c2; out[3] = c3;
}

double op_philox_uniform(uint32_t x) {
    return ((double)x + 0.5) * (1.0 / 4294967296.0);
}

double op_philox_normal(uint32_t batch_lo, uint32_t batch_hi, uint32_t chain_id,
                        uint32_t *draw_block, op_philox_key key) {
    double z = -6.0;
    int block, word;
    if (draw_block == NULL) return 0.0;
    for (block = 0; block < 3; block++) {
        op_philox_ctr ctr;
        uint32_t out[4];
        ctr.v[0] = batch_lo;
        ctr.v[1] = batch_hi;
        ctr.v[2] = chain_id;
        ctr.v[3] = *draw_block;
        (*draw_block)++;
        op_philox4x32_10(ctr, key, out);
        for (word = 0; word < 4; word++) z += op_philox_uniform(out[word]);
    }
    return z;
}

double op_reflect(double x, double a, double b) {
    double width = b - a;
    double y;
    if (!(width > 0.0)) return a;
    y = fmod(x - a, 2.0 * width);
    if (y < 0.0) y += 2.0 * width;
    return y <= width ? a + y : b - (y - width);
}

double op_optimizer_tau(int level) {
    if (level < 0) level = 0;
    if (level >= OP_CHAIN_LEVELS) level = OP_CHAIN_LEVELS - 1;
    return pow(10.0, -6.0 + 6.0 * (double)level / 31.0);
}
