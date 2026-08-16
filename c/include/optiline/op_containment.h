/* Optiline — continuous swept-rectangle containment (§10) and point
 * classification against rational boundaries (Appendix B.1). */
#ifndef OPTILINE_OP_CONTAINMENT_H
#define OPTILINE_OP_CONTAINMENT_H

#include "optiline/op_types.h"
#include "optiline/op_interval.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Proof step: parameter interval certified inside one cell (§10.7). */
typedef struct op_containment_step {
    double  nu0, nu1;   /* global PH parameter interval                */
    int32_t cell;       /* certified cell index                        */
    int32_t depth;
} op_containment_step;

#define OP_MAX_PROOF_STEPS 65536

typedef struct op_containment_proof {
    int32_t count;
    int32_t failure_partition; /* microinterval * 64 + rectangle patch */
    double  min_halfspace_bound; /* minimum certified G over all steps */
    op_containment_step step[OP_MAX_PROOF_STEPS];
} op_containment_proof;

/* Degree-9 Bernstein coefficients of G = b R - n.(z R + A Q) for one
 * corner A and half-space (n,b) on a span sub-interval (§10.3).
 * Exposed for tests and the WGSL conformance reference. */
void op_containment_g_coeffs(const op_span *sp, double nu0, double nu1,
                             op_c64 corner_a, const op_halfspace *hs,
                             double g9[10]);

/* Binary64 adaptive certificate (§10.5): starts from the 256
 * microintervals, subdivides to depth 40, outward-rounded intervals,
 * final test G >= 0 with no artificial clearance. Writes the proof
 * sequence when `proof` is non-NULL. */
op_result op_containment_certify(const op_track *track, const op_spline *line,
                                 const op_vehicle *veh,
                                 op_containment_proof *proof);

/* Point-in-lane classification by rational winding number (App. B.1).
 * Outer boundary is decided by absolute signed area. result: 1 inside
 * (boundary contact counts as inside), 0 outside. */
op_result op_track_point_in_lane(const op_track *track, double px, double py,
                                 int *inside);

/* Cell subset validation used by the track compiler (§7.4): every cell
 * edge tested against both exact rational boundaries by Bernstein root
 * isolation to width 2^-48 + interval Newton; tangencies count. Also
 * interior-point winding test and boundary-component containment test. */
op_result op_cell_validate(const op_track *track, const op_cell *cell);

#ifdef __cplusplus
}
#endif

#endif /* OPTILINE_OP_CONTAINMENT_H */
