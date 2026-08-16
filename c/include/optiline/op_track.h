/* Optiline — track compilation and validation (§7, §19, §20.1–§20.2). */
#ifndef OPTILINE_OP_TRACK_H
#define OPTILINE_OP_TRACK_H

#include "optiline/op_types.h"
#include "optiline/op_construction.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Parsed source track (§7.1, §20.1). */
typedef struct op_track_source {
    char    id[64];
    char    name[128];
    int32_t direction_ccw;   /* 1 ccw, 0 cw */
    int32_t start_gate;      /* must be 0   */
    double  d_left, d_right; /* 7..12 m for catalog tracks */
    op_c64  gates[OP_GATE_COUNT];
} op_track_source;

/* Inward seed clearance for corridor construction (§7.4). */
#define OP_CELL_EPSILON 0.00025

/* Compile a source track into a fully certified op_track (§7.2–§7.5):
 * centerline PH B-spline through all gates, cusp-free exact offsets,
 * boundary simplicity/disjointness, corridor cells with subset proofs,
 * 256 microinterval candidate-cell lists, normalization pair (O, H).
 * The op_qr_workspace is caller-owned scratch. */
op_result op_track_compile(const op_track_source *src, op_track *out,
                           op_qr_workspace *ws);

/* Re-validate a deserialized compiled track (import path, §16.2, §20.2):
 * recompute all certificates from the embedded source record. */
op_result op_track_validate(const op_track *track, op_qr_workspace *ws);

/* Certified corridor-cell generation alone (exposed for tests):
 * adaptive seed tessellation (hull flatness <= 0.25 mm), ring
 * triangulation, convex merging (<= 8 edges), sliding gate overlaps,
 * exact subset validation (§7.4 steps 1–8). */
op_result op_track_build_cells(op_track *track);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_TRACK_H */
