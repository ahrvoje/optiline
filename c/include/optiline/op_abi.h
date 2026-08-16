/* Optiline — host-shareable GPU record mirrors (§14.4).
 * Every field offset and total size is locked by c/tests/test_abi.c
 * against the specification tables. Fixed-width fields only.
 */
#ifndef OPTILINE_OP_ABI_H
#define OPTILINE_OP_ABI_H

#include "optiline/op_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* WGSL ChainState — 1312 bytes. */
typedef struct op_gpu_chain_state {
    float    lap_time;            /* offset 0   */
    float    energy;              /* offset 4   */
    float    sigma;               /* offset 8   */
    float    temperature;         /* offset 12  */
    uint32_t chain_id;            /* offset 16  */
    uint32_t level;               /* offset 20  */
    uint32_t accepted_count;      /* offset 24  */
    uint32_t stagnation;          /* offset 28  */
    float    genotype[64];        /* offset 32  */
    op_c32   preimage[128];       /* offset 288, vec2<f32> pairs */
} op_gpu_chain_state;             /* sizeof == 1312 */

/* WGSL TrackGpuHeader — exactly 128 bytes. */
typedef struct op_gpu_track_header {
    float    origin_x, origin_y, scale_h, inv_scale_h;   /* offset 0   */
    float    le_n, we_n, lv_n, wv_n;                     /* offset 16  */
    float    vmax_sq, ax_plus0, ax_minus0, ay0;          /* offset 32  */
    float    ellipse_p, delta, gamma, kappa_limit;       /* offset 48  */
    uint32_t gate_count, span_count, micro_count, cell_count;      /* 64 */
    uint32_t halfspace_off, candidate_off, gate_off, span_off;     /* 80 */
    uint32_t counter_off, best_off, rejection_off, display_off;    /* 96 */
    uint32_t run_version_lo, run_version_hi, seed_lo, seed_hi;     /* 112 */
} op_gpu_track_header;            /* sizeof == 128 */

/* Corridor half-space as vec4<f32>: (nx, ny, b, unused). */
typedef struct op_gpu_halfspace { float nx, ny, b, unused_; } op_gpu_halfspace;

/* Center gate + left normal as two vec4<f32> slots packed (x,y,nx,ny). */
typedef struct op_gpu_gate { float x, y, nx, ny; } op_gpu_gate;

/* Provisional-best record appended through atomic CAS (§14.2). */
typedef struct op_gpu_best_record {
    float    lap_time;
    uint32_t chain_id;
    uint32_t batch_lo, batch_hi;
    float    genotype[64];
    op_c32   preimage[128];
} op_gpu_best_record;             /* sizeof == 1296 */

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_ABI_H */
